// Content Catalog v2 — canonical Notion property and status names.
// Keep all exact UI/API strings here so emoji/whitespace drift cannot silently
// break page queries or updates.

export const CATALOG_PROPERTIES = Object.freeze({
  status: 'Status',
  lastError: '⚠️ Last Error',
  title: 'Title',
  videoUrl: '🎬 Video URL',
  videoId: '🆔 Video ID',
  category: '🗂️ Category',
  subcategory: '🗂️ Subcategory',
  tags: '🔖 Tags',
  featured: '⭐ Featured',
  // The live Notion schema contains a leading NBSP before the antenna emoji.
  source: '\u00a0📡 Source',
  publishedToGithub: '✅ Published To Github',
  publishedUrl: '🔗 Published URL',
  publishedDate: '📅 Published Date'
});

export const CATALOG_STATUS = Object.freeze({
  notStarted: 'Not started',
  pendingReview: '🟡 Pending Review',
  inProgress: 'In progress',
  draftGenerated: 'Draft Generated',
  transcriptionApproval: '📄 Transcription Approval',
  draftApproval: '✅ Draft Approval',
  publishApproved: '🚀 Publish Approved',
  publishedToGithub: '✅Published To Github',
  errors: '❌ Errors',
  rejected: '❌ Rejected'
});
