/**
 * Persistent conversation storage using Google Sheets
 * Tab: "Conversations" in the same spreadsheet as leads
 */

const SHEETS_ID = process.env.GOOGLE_SHEETS_ID || '1LjJLLHIzGl-s78keZwkGV20GUgaJgw8qKacNTo6UgVk';
const SHEET_NAME = 'Conversations';

const HEADERS = [
  'PSID', 'Name', 'Phone', 'Email', 'Services', 'Branch',
  'Messages', 'Last Active', 'Message Count', 'Source'
];

/**
 * Get Google API access token using service account (same as leads.js)
 */
async function getAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!email || !privateKey) throw new Error('Google service account credentials not configured');

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const base64url = (obj) => {
    const json = JSON.stringify(obj);
    return Buffer.from(json).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  };

  const signInput = `${base64url(header)}.${base64url(payload)}`;
  const crypto = await import('crypto');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signInput);
  const signature = sign.sign(privateKey, 'base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `${signInput}.${signature}`;

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!tokenResponse.ok) throw new Error(`Failed to get access token: ${await tokenResponse.text()}`);
  return (await tokenResponse.json()).access_token;
}

/**
 * Ensure the Conversations sheet/tab exists with headers
 */
async function ensureSheet(accessToken) {
  // Check if sheet exists
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}?fields=sheets.properties.title`;
  const metaRes = await fetch(metaUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  const meta = await metaRes.json();
  const exists = meta.sheets?.some(s => s.properties.title === SHEET_NAME);

  if (!exists) {
    // Create the sheet tab
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}:batchUpdate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: SHEET_NAME } } }] }),
    });
    // Add headers
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/${SHEET_NAME}!A1:J1?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [HEADERS] }),
      }
    );
  }
}

/**
 * Load conversation for a PSID. Returns null if not found.
 */
export async function loadConversation(psid) {
  try {
    const accessToken = await getAccessToken();
    await ensureSheet(accessToken);

    // Get all data
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/${SHEET_NAME}!A:J`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    const rows = data.values || [];

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === psid) {
        const row = rows[i];
        let messages = [];
        try { messages = JSON.parse(row[6] || '[]'); } catch {}
        return {
          rowNumber: i + 1,
          psid: row[0],
          name: row[1] || null,
          phone: row[2] || null,
          email: row[3] || null,
          services: row[4] ? row[4].split(', ').filter(Boolean) : [],
          branch: row[5] || null,
          messages,
          lastActive: row[7] || null,
          messageCount: parseInt(row[8]) || 0,
          source: row[9] || 'messenger',
          lead: {
            name: row[1] || null,
            phones: row[2] ? row[2].split(', ').filter(Boolean) : [],
            emails: row[3] ? row[3].split(', ').filter(Boolean) : [],
            services: row[4] ? row[4].split(', ').filter(Boolean) : [],
            preferredBranch: row[5] || null,
            needsDescription: null,
          },
        };
      }
    }
    return null;
  } catch (error) {
    console.error('Failed to load conversation from sheet:', error);
    return null;
  }
}

/**
 * Save conversation back to the sheet (upsert)
 */
export async function saveConversation(psid, conv) {
  try {
    const accessToken = await getAccessToken();
    await ensureSheet(accessToken);

    const timestamp = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
    const messagesJson = JSON.stringify((conv.messages || []).slice(-20));
    const lead = conv.lead || {};

    const values = [[
      psid,
      lead.name || conv.name || '',
      (lead.phones || []).join(', ') || conv.phone || '',
      (lead.emails || []).join(', ') || conv.email || '',
      (lead.services || []).join(', '),
      lead.preferredBranch || conv.branch || '',
      messagesJson.substring(0, 40000),
      timestamp,
      conv.messageCount || 0,
      'messenger',
    ]];

    if (conv.rowNumber) {
      // Update existing
      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/${SHEET_NAME}!A${conv.rowNumber}:J${conv.rowNumber}?valueInputOption=USER_ENTERED`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values }),
        }
      );
    } else {
      // Append new
      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/${SHEET_NAME}!A:J:append?valueInputOption=USER_ENTERED`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values }),
        }
      );
    }
  } catch (error) {
    console.error('Failed to save conversation to sheet:', error);
  }
}
