const p = require('E:/GitHub/_Koishi/Koishi/koishi-app/external/group-whitelist/lib/index.js');
const t = JSON.stringify(p.Config);
let from = 0, n = 0;
while ((from = t.indexOf('"const"', from)) >= 0) {
  n++;
  if (n >= 6) console.log('--- const#' + n + ':', t.slice(Math.max(0, from - 200), from + 80));
  from += 7;
}
console.log('const 总数:', n);
