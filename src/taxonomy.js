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
  'unclear',
];

export const EMOTIONS = [
  'happy', 'excited', 'grateful', 'amused', 'calm', 'neutral',
  'confused', 'surprised', 'anxious', 'sad', 'disappointed',
  'frustrated', 'annoyed', 'angry', 'embarrassed', 'hurt',
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
