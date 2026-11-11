// The browser bundle never reads or writes files; lib/contracts.js only touches fs when it loads the n8n feed.
module.exports = { readFileSync() { throw new Error('no files in the browser'); }, writeFileSync() {} };
