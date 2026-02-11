const fs = require('fs');
const content = fs.readFileSync('/Users/juniorsartori/Projects/Kody/kodus-ai/libs/common/utils/codeReview/v2Defaults.ts', 'utf8');

function countSection(name) {
  const regex = new RegExp(name + ":\\s*\\[([\\s\\S]*?)\\]\\.join", "m");
  const match = content.match(regex);
  if (!match) return 0;
  const strings = match[1].match(/'([^']*)'/g) || [];
  return strings.reduce((sum, s) => sum + s.slice(1, -1).length + 1, 0);
}

console.log('bug:        ', countSection('bug'), 'chars');
console.log('performance:', countSection('performance'), 'chars');
console.log('security:   ', countSection('security'), 'chars');
console.log('---');
console.log('limit:       2000 chars');
