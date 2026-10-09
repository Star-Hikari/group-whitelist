const p = require('E:/GitHub/_Koishi/Koishi/koishi-app/external/group-whitelist/lib/index.js');
const t = JSON.stringify(p.Config);
let from = 0, n = 0;
while ((from = t.indexOf('"const"', from)) >= 0 && n < 5) {
  console.log('--- const at', from, ':', t.slice(Math.max(0, from - 220), from + 90));
  from += 7; n++;
}
