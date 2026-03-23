/**
 * Lead Capture API - Posts to WVDI Admin Supabase backend
 * Replaces Google Sheets integration
 * Version: 3.0.0
 */

const API_VERSION = '3.0.0';
const ADMIN_API_URL = process.env.WVDI_ADMIN_API_URL || 'https://wvdi-admin.vercel.app/api/leads';
const ADMIN_API_KEY = process.env.CHATBOT_API_KEY;

/**
 * API Handler
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { sessionId, lead, conversationSummary, fullConversation } = req.body;

    console.log('Leads API received:', {
      sessionId: sessionId || 'MISSING',
      hasLead: !!lead,
      leadName: lead?.name
    });

    if (!lead) {
      return res.status(400).json({ error: 'Lead data is required' });
    }

    if (!sessionId) {
      return res.status(400).json({ error: 'Thread ID is required' });
    }

    const name = lead.name || '';
    const email = Array.isArray(lead.emails) ? lead.emails[0] : (lead.email || '');
    const phone = Array.isArray(lead.phones) ? lead.phones[0] : (lead.phone || '');
    const services = Array.isArray(lead.services) ? lead.services.join(', ') : (lead.services || '');
    const summary = lead.needsDescription || '';
    const conversation = (fullConversation || lead.fullConversation || conversationSummary || '').substring(0, 50000);

    if (!name && !email && !phone) {
      return res.status(200).json({
        success: false,
        message: 'No contact information to save'
      });
    }

    // Parse conversation into messages array
    const messages = [];
    if (conversation) {
      let lastRole = 'assistant';
      const parts = conversation.split('\n\n');
      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('Customer:')) {
          lastRole = 'user';
          messages.push({ role: 'user', text: trimmed.slice(9).trim() });
        } else if (trimmed.startsWith('DriveBot:')) {
          lastRole = 'assistant';
          messages.push({ role: 'assistant', text: trimmed.slice(9).trim() });
        } else {
          // Continuation of the previous message — append to it
          if (messages.length > 0) {
            messages[messages.length - 1].text += '\n\n' + trimmed;
          } else {
            messages.push({ role: lastRole, text: trimmed });
          }
        }
      }
    }

    // POST to WVDI Admin API
    const payload = {
      source: 'web',
      thread_id: sessionId,
      name,
      email: email || undefined,
      phone: phone || undefined,
      services: services || undefined,
      summary: summary || undefined,
      messages,
    };

    if (!ADMIN_API_KEY) {
      console.error('CHATBOT_API_KEY not configured');
      return res.status(500).json({ error: 'API key not configured' });
    }

    const response = await fetch(ADMIN_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': ADMIN_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('WVDI Admin API error:', result);
      return res.status(500).json({
        error: 'Failed to save lead',
        details: result.error || 'Unknown error',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Lead saved successfully',
      version: API_VERSION,
      threadId: sessionId,
      contact_id: result.contact_id,
      matched: result.matched,
    });

  } catch (error) {
    console.error('Error saving lead:', error);
    return res.status(500).json({
      error: 'Failed to save lead',
      details: error.message,
    });
  }
}
