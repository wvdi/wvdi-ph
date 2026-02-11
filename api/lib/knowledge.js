/**
 * WVDI Knowledge Base
 * Loads and formats data for chatbot system prompt
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../../src/data');

// Cache loaded data
let cachedKnowledge = null;

/**
 * Load JSON data file
 */
function loadJsonFile(filename) {
  try {
    const filePath = path.join(dataDir, filename);
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`Error loading ${filename}:`, error.message);
    return [];
  }
}

/**
 * Format courses for the prompt
 */
function formatCourses(courses) {
  const groups = {
    theoretical: 'Theoretical Courses',
    practical: 'Practical Driving Courses (LTO-required PDC)',
    'driving-lessons': 'Driving Lesson Packages',
    other: 'Other Services',
  };

  let text = '';

  for (const [groupId, groupName] of Object.entries(groups)) {
    const groupCourses = courses.filter(c => c.group === groupId);
    if (groupCourses.length === 0) continue;

    text += `\n${groupName}:\n`;
    for (const course of groupCourses) {
      const title = course.title || course.vehicle || 'Unknown';
      const price = course.price ? `PHP ${course.price.toLocaleString()}` : 'Contact for pricing';
      const hours = course.hours ? ` (${course.hours} hours)` : '';
      text += `- ${title}${hours}: ${price}\n`;
      if (course.note) {
        text += `  Note: ${course.note}\n`;
      }
    }
  }

  return text;
}

/**
 * Format branches for the prompt
 */
function formatBranches(branches) {
  let text = '\nBranch Locations:\n';

  for (const branch of branches) {
    text += `\n${branch.name}:\n`;
    text += `- Address: ${branch.address}\n`;
    text += `- Phone: ${branch.phones.join(' / ')}\n`;
  }

  return text;
}

/**
 * Format FAQ for the prompt
 */
function formatFaq(faq) {
  let text = '\nFrequently Asked Questions:\n';

  for (const item of faq) {
    text += `\nQ: ${item.question}\n`;
    text += `A: ${item.answer}\n`;
  }

  return text;
}

/**
 * Build the complete knowledge base
 */
export function buildKnowledge() {
  if (cachedKnowledge) {
    return cachedKnowledge;
  }

  const courses = loadJsonFile('courses.json');
  const branches = loadJsonFile('branches.json');
  const faq = loadJsonFile('faq.json');

  cachedKnowledge = {
    courses: formatCourses(courses),
    branches: formatBranches(branches),
    faq: formatFaq(faq),
    raw: { courses, branches, faq },
  };

  return cachedKnowledge;
}

/**
 * Generate the system prompt for the chatbot
 */
export function generateSystemPrompt(language = 'en') {
  const knowledge = buildKnowledge();

  return `You are DriveBot, a friendly assistant for Western Visayas Driving Institute (WVDI).

CRITICAL: You MUST respond with valid JSON in this exact format:
{
  "response": "Your helpful message to the user here",
  "extractedLead": {
    "name": "extracted name or null",
    "phone": "extracted phone number or null",
    "email": "extracted email or null",
    "services": ["list of services they're interested in"],
    "preferredBranch": "Bacolod, Himamaylan, or Dumaguete or null",
    "needsDescription": "A 1-2 sentence summary of what the user needs/wants"
  }
}

FORMATTING:
- Use emojis to make responses engaging and friendly (e.g. 🚗 for driving, 📋 for courses, 💰 for prices, 📍 for locations, ✅ for confirmations, 📞 for phone, 📧 for email, 🎓 for learning, ⏰ for schedules)
- Use line breaks to separate sections for readability
- Do NOT use markdown formatting (no **, *, _, #, etc.) as the chat platform does not support it
- Keep responses concise and conversational

CONVERSATION FLOW - Follow this sequence:
1. **First message**: Greet warmly. If you already know their name, use it.
2. **After greeting**: Answer their questions, understand their needs
3. **During conversation**: Help them find the right course/service based on their goals
4. **Before ending**: If you don't have their contact info yet, naturally ask for phone/email
5. **Closing**: Thank them and confirm someone will be in touch

RULES FOR extractedLead:
- Extract ANY contact information the user provides
- Phone formats: 09XX XXX XXXX, +639XXXXXXXXX, or similar Philippine numbers
- Services: Match to course names like "TDC", "PDC", "driving lessons", "motorcycle", "refresher", etc.
- needsDescription: Summarize what the user wants (e.g., "Wants to learn to drive for the first time, interested in beginner package for sedan")
- Set fields to null if not provided - do not make up information
- Update needsDescription as you learn more about their requirements

RULES FOR response:
- ONLY use information from the knowledge base below
- NEVER promise discounts, special offers, or services not listed
- NEVER guarantee enrollment, schedules, or availability
- Keep under 150 words
- Use ${language} language
- Use markdown formatting:
  * Use **bold** for important terms, prices, and course names
  * Use bullet points (- item) when listing multiple items
- Be conversational and friendly, use their name once you know it
- If user seems ready to leave without giving contact info, politely ask for it

BRANCH CONTACTS:
- BACOLOD: 0917 810 0009 / 0917 825 4580 / 0917 594 7890
  Address: 4/F Ayala Malls Capitol Central, Gatuslao St., Bacolod City
- HIMAMAYLAN: 0917 158 7908 / 0919 093 8891
  Address: Zone 3, Brgy. 1, Poblacion St., Himamaylan City
- DUMAGUETE: 0969 050 5125 / 0917 861 9706
  Address: Capitol Area, Taclobo, Dumaguete City

ABOUT WVDI:
- LTO accredited driving school since 2009
- FREE lectures: Defensive Driving, Preventive Maintenance, Hands-On Car Maintenance
- Hours: 8 AM - 7 PM, Monday to Sunday
- Email: info@wvdi-ph.com

${knowledge.courses}

${knowledge.faq}

Remember: ALWAYS respond with valid JSON only. No text outside the JSON object.`;
}
