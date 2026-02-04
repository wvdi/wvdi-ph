/**
 * Facebook Messenger Webhook API
 * Receives messages from Messenger and responds with AI
 * Also captures leads to Google Sheets
 */

import { getProvider } from './providers/index.js';
import { generateSystemPrompt } from './lib/knowledge.js';

// Verify token for webhook setup (set in Vercel env vars)
const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN || 'wvdi_messenger_verify_2024';
const PAGE_ACCESS_TOKEN = process.env.MESSENGER_PAGE_ACCESS_TOKEN;
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || '1LjJLLHIzGl-s78keZwkGV20GUgaJgw8qKacNTo6UgVk';

// In-memory conversation storage (use Redis in production)
const conversations = new Map();
const CONVERSATION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

/**
 * Get or create conversation context
 */
function getConversation(senderId) {
  if (!conversations.has(senderId)) {
    conversations.set(senderId, {
      messages: [],
      lead: {
        phones: [],
        emails: [],
        name: null,
        services: [],
        preferredBranch: null,
        needsDescription: null,
      },
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });
  }
  
  const conv = conversations.get(senderId);
  conv.lastActivity = Date.now();
  return conv;
}

/**
 * Cleanup old conversations
 */
function cleanupConversations() {
  const now = Date.now();
  for (const [id, conv] of conversations.entries()) {
    if (now - conv.lastActivity > CONVERSATION_TIMEOUT) {
      conversations.delete(id);
    }
  }
}

setInterval(cleanupConversations, 10 * 60 * 1000);

/**
 * Send message via Messenger API
 */
async function sendMessengerMessage(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error('MESSENGER_PAGE_ACCESS_TOKEN not configured');
    return false;
  }

  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  
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
  const conversation = getConversation(senderId);
  
  // Add user message to history
  conversation.messages.push({
    role: 'user',
    content: messageText,
  });

  // Keep only last 20 messages for context
  if (conversation.messages.length > 20) {
    conversation.messages = conversation.messages.slice(-20);
  }

  // Get user profile for personalization (first message only)
  if (conversation.messages.length === 1) {
    const profile = await getUserProfile(senderId);
    if (profile?.first_name) {
      conversation.lead.name = profile.name || profile.first_name;
    }
  }

  // Generate system prompt
  const systemPrompt = generateSystemPrompt('en');

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

    // Parse JSON response
    let responseText = rawResponse;
    let aiExtractedLead = null;

    try {
      let jsonStr = rawResponse.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }

      const parsed = JSON.parse(jsonStr);
      responseText = parsed.response || rawResponse;
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
      responseText = rawResponse;
    }

    // Add assistant message to history
    conversation.messages.push({
      role: 'assistant',
      content: responseText,
    });

    return responseText;

  } catch (error) {
    console.error('AI processing error:', error);
    return "I apologize, but I'm having trouble processing your request right now. Please try again or contact us directly at 0917 810 0009.";
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

    // Verify this is from a Page subscription
    if (body.object !== 'page') {
      return res.status(404).send('Not Found');
    }

    // Respond immediately to Facebook (they require <20s response)
    res.status(200).send('EVENT_RECEIVED');

    // Process messages asynchronously
    try {
      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          const senderId = event.sender?.id;
          
          // Skip if no sender or it's the page itself
          if (!senderId || senderId === entry.id) continue;

          // Handle message
          if (event.message?.text) {
            const messageText = event.message.text;
            
            // Send typing indicator
            await sendTypingIndicator(senderId, 'typing_on');

            // Process and respond
            const response = await processMessage(senderId, messageText);
            
            // Send response
            await sendMessengerMessage(senderId, response);
            
            // Turn off typing indicator
            await sendTypingIndicator(senderId, 'typing_off');
          }

          // Handle postback (button clicks)
          if (event.postback?.payload) {
            // Could handle quick reply buttons here
            console.log('Postback received:', event.postback.payload);
          }
        }
      }
    } catch (error) {
      console.error('Error processing Messenger webhook:', error);
    }

    return;
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
