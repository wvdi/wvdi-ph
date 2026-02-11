/**
 * Facebook Messenger Webhook API
 * Receives messages from Messenger and responds with AI
 * Also captures leads to Google Sheets
 */

import { getProvider } from './providers/index.js';
import { generateSystemPrompt } from './lib/knowledge.js';
import { loadConversation, saveConversation } from './lib/conversations-sheet.js';

// Verify token for webhook setup (set in Vercel env vars)
const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN || 'wvdi_messenger_verify_2024';
const PAGE_ACCESS_TOKEN = process.env.MESSENGER_PAGE_ACCESS_TOKEN;
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || '1LjJLLHIzGl-s78keZwkGV20GUgaJgw8qKacNTo6UgVk';

// Staff PSIDs (Page-Scoped IDs) - bot won't auto-reply to these
// Add staff Facebook PSIDs here after identifying them
const STAFF_PSIDS = new Set([
  // Will be populated with staff PSIDs
  // Format: '1234567890123456'
]);

// Conversations where staff has taken over (bot stays silent but logs)
const staffTakeovers = new Map(); // recipientId -> { takenOverAt, staffPsid }

// In-memory cache (backed by Google Sheets for persistence)
const conversationCache = new Map();

/**
 * Get or create conversation context (loads from Google Sheets if not cached)
 */
async function getConversation(senderId) {
  if (conversationCache.has(senderId)) {
    const conv = conversationCache.get(senderId);
    conv.lastActivity = Date.now();
    return conv;
  }

  // Try loading from Google Sheets
  const stored = await loadConversation(senderId);
  if (stored) {
    stored.lastActivity = Date.now();
    stored.messageCount = (stored.messageCount || 0);
    conversationCache.set(senderId, stored);
    return stored;
  }

  // New conversation
  const conv = {
    messages: [],
    lead: {
      phones: [],
      emails: [],
      name: null,
      services: [],
      preferredBranch: null,
      needsDescription: null,
    },
    messageCount: 0,
    lastActivity: Date.now(),
    rowNumber: null,
  };
  conversationCache.set(senderId, conv);
  return conv;
}

/**
 * Send message via Messenger API
 */
async function sendMessengerMessage(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error('MESSENGER_PAGE_ACCESS_TOKEN not configured');
    return false;
  }

  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  
  // Strip markdown formatting (Messenger doesn't support it)
  text = text
    .replace(/\*{2,}([^*]*)\*{0,}/g, '$1')  // **bold** or **incomplete -> plain
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1') // *italic* -> plain
    .replace(/__(.+?)__/g, '$1')       // __bold__ -> bold
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1') // _italic_ -> italic
    .replace(/`(.+?)`/g, '$1')         // `code` -> code
    .replace(/#{1,6}\s+/g, '')         // ### headers -> plain
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1: $2') // [link](url) -> link: url
    .replace(/\*{1,2}/g, '');          // cleanup any remaining stray asterisks
  
  // Split long messages (Messenger limit is ~2000 chars)
  const chunks = text.match(/.{1,1900}/gs) || [text];
  
  for (const chunk of chunks) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text: chunk },
          messaging_type: 'RESPONSE',
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('Messenger send error:', error);
        return false;
      }
    } catch (error) {
      console.error('Failed to send Messenger message:', error);
      return false;
    }
  }
  
  return true;
}

/**
 * Send typing indicator
 */
async function sendTypingIndicator(recipientId, action = 'typing_on') {
  if (!PAGE_ACCESS_TOKEN) return;

  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        sender_action: action,
      }),
    });
  } catch (error) {
    console.error('Failed to send typing indicator:', error);
  }
}

/**
 * Send quick reply buttons for phone/email
 */
async function sendQuickReplyButtons(recipientId) {
  if (!PAGE_ACCESS_TOKEN) return;
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: 'RESPONSE',
        message: {
          text: 'To help you faster, you can share your contact info below:',
          quick_replies: [
            { content_type: 'user_phone_number' },
            { content_type: 'user_email' },
          ],
        },
      }),
    });
  } catch (error) {
    console.error('Failed to send quick reply buttons:', error);
  }
}

/**
 * Get user profile from Facebook
 */
async function getUserProfile(userId) {
  if (!PAGE_ACCESS_TOKEN) return null;

  const url = `https://graph.facebook.com/v19.0/${userId}?fields=first_name,last_name,name&access_token=${PAGE_ACCESS_TOKEN}`;
  
  try {
    const response = await fetch(url);
    if (response.ok) {
      return await response.json();
    }
  } catch (error) {
    console.error('Failed to get user profile:', error);
  }
  
  return null;
}

/**
 * Process incoming message and generate AI response
 */
async function processMessage(senderId, messageText) {
  const conversation = await getConversation(senderId);
  
  // Add user message to history
  conversation.messages.push({
    role: 'user',
    content: messageText,
  });
  conversation.messageCount = (conversation.messageCount || 0) + 1;

  // Keep only last 20 messages for context
  if (conversation.messages.length > 20) {
    conversation.messages = conversation.messages.slice(-20);
  }

  // Always ensure we have the user profile
  if (!conversation.lead.name) {
    const profile = await getUserProfile(senderId);
    if (profile?.first_name) {
      conversation.lead.name = profile.name || profile.first_name;
    }
  }

  // Generate system prompt with injected user context
  let systemPrompt = generateSystemPrompt('en');
  
  // Inject known user info so AI doesn't ask for it
  console.log(`Lead data for ${senderId}:`, JSON.stringify(conversation.lead));
  const contextLines = [];
  if (conversation.lead.name) {
    const firstName = conversation.lead.name.split(' ')[0];
    contextLines.push(`The customer's first name is ${firstName}. Address them by first name only. Do not ask for their name.`);
  }
  if (conversation.lead.phones?.length > 0) {
    contextLines.push(`The customer's phone is ${conversation.lead.phones.join(', ')}. Do not ask for their phone number.`);
  }
  if (conversation.lead.emails?.length > 0) {
    contextLines.push(`The customer's email is ${conversation.lead.emails.join(', ')}. Do not ask for their email.`);
  }
  if (contextLines.length > 0) {
    systemPrompt += '\n\nKNOWN CUSTOMER INFO:\n' + contextLines.join('\n') + '\nIMPORTANT: NEVER ask the customer for information listed above. You already have it. Do not ask for their name, phone, or email if already known. Instead, use the information to assist them directly.';
  }

  // Get AI response
  const provider = getProvider();
  
  try {
    const aiResponse = await provider.chat({
      systemPrompt,
      messages: conversation.messages,
      temperature: 0.7,
      maxTokens: 800,
      jsonMode: true,
    });

    const rawResponse = typeof aiResponse === 'string' ? aiResponse : aiResponse.content;
    console.log('Raw AI response (first 200):', rawResponse.substring(0, 200));

    // Parse JSON response
    let responseText = rawResponse;
    let aiExtractedLead = null;

    try {
      let jsonStr = rawResponse.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }

      const parsed = JSON.parse(jsonStr);
      responseText = parsed.response || parsed.text || parsed.message || rawResponse;
      console.log('Parsed response (first 200):', responseText.substring(0, 200));
      aiExtractedLead = parsed.extractedLead || null;

      // Merge extracted lead data
      if (aiExtractedLead) {
        if (aiExtractedLead.name) conversation.lead.name = aiExtractedLead.name;
        if (aiExtractedLead.phone) {
          const phones = Array.isArray(aiExtractedLead.phone) ? aiExtractedLead.phone : [aiExtractedLead.phone];
          conversation.lead.phones = [...new Set([...conversation.lead.phones, ...phones.filter(p => p)])];
        }
        if (aiExtractedLead.email) {
          const emails = Array.isArray(aiExtractedLead.email) ? aiExtractedLead.email : [aiExtractedLead.email];
          conversation.lead.emails = [...new Set([...conversation.lead.emails, ...emails.filter(e => e)])];
        }
        if (aiExtractedLead.services && Array.isArray(aiExtractedLead.services)) {
          conversation.lead.services = [...new Set([...conversation.lead.services, ...aiExtractedLead.services.filter(s => s)])];
        }
        if (aiExtractedLead.preferredBranch) {
          conversation.lead.preferredBranch = aiExtractedLead.preferredBranch;
        }
        if (aiExtractedLead.needsDescription) {
          conversation.lead.needsDescription = aiExtractedLead.needsDescription;
        }
      }
    } catch (parseError) {
      console.warn('Failed to parse AI JSON response:', parseError.message);
      // If JSON parsing fails, try to extract just the text content
      // Remove any JSON wrapper if partially formed
      responseText = rawResponse
        .replace(/^\s*\{\s*"response"\s*:\s*"/, '')
        .replace(/"\s*,?\s*"extractedLead"[\s\S]*$/, '')
        .replace(/"\s*\}\s*$/, '')
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"');
    }

    // Add assistant message to history
    conversation.messages.push({
      role: 'assistant',
      content: responseText,
    });

    // Persist conversation to Google Sheets
    try {
      await saveConversation(senderId, conversation);
    } catch (err) {
      console.error('Failed to persist conversation:', err);
    }

    return { text: responseText, isFirstResponse: conversation.messageCount === 1 };

  } catch (error) {
    console.error('AI processing error:', error);
    return { text: "I apologize, but I'm having trouble processing your request right now. Please try again or contact us directly at 0917 810 0009.", isFirstResponse: false };
  }
}

/**
 * API Handler
 */
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Webhook verification (GET request from Facebook)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Messenger webhook verified');
      return res.status(200).send(challenge);
    } else {
      console.error('Webhook verification failed');
      return res.status(403).send('Forbidden');
    }
  }

  // Message webhook (POST request from Facebook)
  if (req.method === 'POST') {
    const body = req.body;
    
    // Debug logging
    console.log('=== MESSENGER WEBHOOK RECEIVED ===');
    console.log('Body object:', body.object);
    console.log('Full body:', JSON.stringify(body, null, 2));

    // Verify this is from a Page subscription
    if (body.object !== 'page') {
      console.log('Not a page object, returning 404');
      return res.status(404).send('Not Found');
    }

    // Process messages BEFORE responding (Vercel kills function after res.send)
    try {
      for (const entry of body.entry || []) {
        const pageId = entry.id;
        
        for (const event of entry.messaging || []) {
          const senderId = event.sender?.id;
          const recipientId = event.recipient?.id;
          
          // Skip if no sender
          if (!senderId) continue;

          // Detect if this is from the page (staff or bot replying)
          const isFromPage = senderId === pageId;
          
          // Check if this is an echo of a message we sent via API (bot message)
          // Facebook sends is_echo: true for messages sent via the Send API
          const isEcho = event.message?.is_echo === true;
          
          // If page is sending AND it's NOT an echo, it's a human staff member
          if (isFromPage && recipientId && !isEcho) {
            staffTakeovers.set(recipientId, {
              takenOverAt: Date.now(),
              staffPsid: senderId,
            });
            console.log(`Staff takeover: conversation with ${recipientId}`);
            
            // Still log the staff message in conversation history
            const conversation = await getConversation(recipientId);
            if (event.message?.text) {
              conversation.messages.push({
                role: 'assistant', // Staff acts as assistant
                content: `[STAFF]: ${event.message.text}`,
              });
            }
            continue; // Don't process further
          }
          
          // Skip echo messages (our own bot responses)
          if (isEcho) {
            continue;
          }

          // Skip if sender is staff (they're initiating, not a customer)
          if (STAFF_PSIDS.has(senderId)) {
            console.log(`Skipping staff message from ${senderId}`);
            continue;
          }

          // Check if this conversation was taken over by staff
          const takeover = staffTakeovers.get(senderId);
          if (takeover) {
            // Staff took over within last 2 hours - don't auto-reply
            const twoHours = 2 * 60 * 60 * 1000;
            if (Date.now() - takeover.takenOverAt < twoHours) {
              console.log(`Conversation ${senderId} handled by staff, logging only`);
              
              // Still log the customer message
              if (event.message?.text) {
                const conversation = await getConversation(senderId);
                conversation.messages.push({
                  role: 'user',
                  content: event.message.text,
                });
              }
              continue; // Don't auto-reply
            } else {
              // Takeover expired, remove it
              staffTakeovers.delete(senderId);
            }
          }

          // Handle quick reply responses (phone/email from native buttons)
          if (event.message?.quick_reply) {
            const qrPayload = event.message.quick_reply.payload;
            const conversation = await getConversation(senderId);
            
            // Check if this is a phone number shared via quick reply
            if (qrPayload && event.message.text) {
              const text = event.message.text;
              // Phone numbers from user_phone_number quick reply
              if (text.match(/^\+?\d[\d\s\-()]{6,}$/)) {
                conversation.lead.phones = [...new Set([...(conversation.lead.phones || []), text])];
                console.log(`Captured phone from quick reply: ${text}`);
                await sendMessengerMessage(senderId, `Thanks! I've noted your phone number: ${text}. How can I help you today?`);
                await saveConversation(senderId, conversation);
                continue;
              }
              // Email from user_email quick reply
              if (text.match(/@/)) {
                conversation.lead.emails = [...new Set([...(conversation.lead.emails || []), text])];
                console.log(`Captured email from quick reply: ${text}`);
                await sendMessengerMessage(senderId, `Thanks! I've noted your email: ${text}`);
                await saveConversation(senderId, conversation);
                continue;
              }
            }
          }

          // Handle customer message
          if (event.message?.text && !event.message?.quick_reply) {
            const messageText = event.message.text;
            console.log(`Processing message from ${senderId}: ${messageText}`);
            
            // Send typing indicator
            await sendTypingIndicator(senderId, 'typing_on');

            // Process and respond
            const result = await processMessage(senderId, messageText);
            console.log(`AI response: ${result.text.substring(0, 100)}...`);
            
            // Send response
            const sent = await sendMessengerMessage(senderId, result.text);
            console.log(`Message sent: ${sent}`);
            
            // Send quick reply buttons only if we're missing phone or email
            const conv = getConversation(senderId);
            const hasPhone = conv.lead?.phones?.length > 0;
            const hasEmail = conv.lead?.emails?.length > 0;
            if (result.isFirstResponse && !hasPhone && !hasEmail) {
              await sendQuickReplyButtons(senderId);
            }
            
            // Turn off typing indicator
            await sendTypingIndicator(senderId, 'typing_off');
          }

          // Handle postback (button clicks)
          if (event.postback?.payload) {
            console.log('Postback received:', event.postback.payload);
          }
        }
      }
    } catch (error) {
      console.error('Error processing Messenger webhook:', error);
    }

    // Respond to Facebook AFTER processing (within 20s limit)
    return res.status(200).send('EVENT_RECEIVED');
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
