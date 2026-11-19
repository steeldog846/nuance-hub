// The shared vocabulary that agents, the app and human labelers all use.
// Keeping it fixed (with a free-text escape hatch) is what makes the
// answers aggregatable and usable as training data.

export const INTENTS = [
  'sincere',            // means exactly what they say
  'sarcastic',          // says the opposite of what they mean, usually mocking
  'ironic',             // situational/verbal irony without mockery
  'joking',             // playful, not meant seriously
  'passive_aggressive', // polite surface, hostile underneath
  'rhetorical',         // question not expecting an answer
  'understatement',     // deliberately downplays
  'exaggeration',       // hyperbole
  'polite_refusal',     // "maybe later" meaning no
  'teasing',            // playful jab, often a bit cocky
  'unclear',
];

export const EMOTIONS = [
  'happy', 'excited', 'grateful', 'amused', 'calm', 'neutral',
  'confused', 'surprised', 'anxious', 'sad', 'disappointed',
  'frustrated', 'annoyed', 'angry', 'embarrassed', 'hurt', 'smug',
];

// What part of the message the agent could not understand.
export const DIFFICULTY_TYPES = ['emotion', 'intent', 'language', 'expression', 'cultural', 'other'];

export const MODALITIES = ['text', 'voice_transcript', 'video_transcript', 'chat'];

export function isValidIntent(v) { return INTENTS.includes(v); }
export function isValidEmotion(v) { return EMOTIONS.includes(v); }

// Where a question came from. Any AI can connect; this only groups the stats
// and tells labelers which kind of assistant got confused.
export const PLATFORMS = [
  'claude', 'chatgpt', 'gemini', 'copilot', 'meta_ai', 'grok', 'mistral',
  'deepseek', 'perplexity', 'pi_network', 'open_source', 'custom', 'other',
];

// Plain, first-person wording for one-tap choices shown to the person
// right inside the conversation. Short on purpose: people tap, not type.
export const INTENT_PHRASES = {
  sincere: 'I meant it',
  sarcastic: 'I was being sarcastic',
  ironic: 'I was being ironic',
  joking: 'Just joking',
  passive_aggressive: "I'm actually annoyed",
  rhetorical: "I wasn't really asking",
  understatement: "It's a bigger deal than it sounds",
  exaggeration: 'I was exaggerating',
  polite_refusal: "That's a polite no",
  teasing: 'I was teasing',
  unclear: 'Not sure myself',
};

export const EMOTION_EMOJI = {
  happy: '😊', excited: '🤩', grateful: '🙏', amused: '😄', calm: '😌', neutral: '😐',
  confused: '😕', surprised: '😮', anxious: '😟', sad: '😢', disappointed: '😞',
  frustrated: '😤', annoyed: '🙄', angry: '😠', embarrassed: '😳', hurt: '💔', smug: '😏',
};

// Quick reactions to what the AI did after it understood (or misunderstood).
export const REACTIONS = {
  helpful: 'That helped',
  missed: 'Still missed the point',
  tone: 'Right idea, wrong tone',
};
