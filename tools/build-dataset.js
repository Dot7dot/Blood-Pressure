// 產生訓練資料：node tools/build-dataset.js <輸出資料夾> <場景數> [起始 seed]
// 需要先在專案根目錄啟動本機伺服器：python3 -m http.server 8765
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const [,, outDir = 'tools/data', total = '6000', seed0 = '1000'] = process.argv;
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const WORKERS = 4;
  const PER = 100;
  const jobs = [];
  for (let s = 0; s < Number(total); s += PER) jobs.push(Number(seed0) + s);
  const Xs = []; const ys = []; let D = 0;
  const worker = async () => {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('ERR', e.message));
    await page.goto('http://localhost:8765/tools/dataset.html');
    await page.waitForFunction('window.ready');
    while (jobs.length) {
      const seed = jobs.shift();
      const r = await page.evaluate(([seed, n]) => window.batch(seed, n), [seed, PER]);
      Xs.push(Buffer.from(r.X, 'base64')); ys.push(Buffer.from(r.y, 'base64')); D = r.D;
      process.stdout.write(`seed ${seed}: ${r.n} 筆\n`);
    }
    await page.close();
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));
  await browser.close();
  fs.writeFileSync(path.join(outDir, 'X.u8'), Buffer.concat(Xs));
  fs.writeFileSync(path.join(outDir, 'y.u8'), Buffer.concat(ys));
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({ D }));
  console.log('完成', Buffer.concat(ys).length, '筆，維度', D);
})();
