const { chromium } = require("playwright");
const out = process.argv[2];
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("CONSOLE_ERR", m.text().slice(0, 200));
  });
  await page.goto("http://localhost:13999/pair#token=" + process.argv[3]);
  await page.waitForTimeout(4000);
  await page.goto("http://localhost:13999/");
  await page.waitForTimeout(3000);
  const items = page.locator('[data-sidebar="content"] [data-thread-item]');
  const names = async () => (await items.allInnerTexts()).map((t) => t.split("\n")[0]);
  console.log("ROWS0", JSON.stringify(await names()));
  await items.nth(0).click({ modifiers: ["Control"] });
  await items.nth(1).click({ modifiers: ["Control"] });
  await items.nth(2).click({ modifiers: ["Control"] });
  await page.waitForTimeout(500);
  await items.nth(0).click({ button: "right" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: out + "-bulkmenu.png" });
  await page.getByText("Group (3)", { exact: true }).click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: out + "-groupsub.png" });
  console.log("ROWS1", JSON.stringify(await names()));
  await page.mouse.click(700, 700);
  await page.screenshot({ path: out + "-grouped.png" });
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
