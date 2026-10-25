const fs = require('fs');
const { JSDOM } = require('jsdom');

let html = fs.readFileSync('AI记账.html', 'utf8');
html = html
  .replace(/<script src="https:[^>]*><\/script>/g, '')
  .replace(/<script src="cloud-config\.js"><\/script>/g, '');

// inject styles.css as a <style> so getComputedStyle reflects it
const css = fs.readFileSync('styles.css', 'utf8');
html = html.replace('</head>', '<style>' + css + '</style></head>');

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://localhost/' });
const { window } = dom;
const { document } = window;

const scripts = ['data.js','nlp.js','engine.js','coach.js','deals.js','analysis.js','ocr.js','app.js'];
for (const s of scripts) {
  const code = fs.readFileSync(s, 'utf8');
  try { window.eval(code); } catch (e) { console.log('EVAL ERROR in', s, '->', e.message); }
}
document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

function dump(label) {
  const els = Array.from(document.querySelectorAll('.ui-full-only'));
  console.log(`\n[${label}] body data-ui-mode =`, document.body.getAttribute('data-ui-mode'));
  console.log(`  .ui-full-only count =`, els.length);
  els.forEach(el => {
    const cs = window.getComputedStyle(el);
    console.log(`   - #${el.id || '(none)'} <${el.tagName}> display=${cs.display}`);
  });
}

dump('FULL mode (init)');

// switch to simple
const simple = document.querySelector('input[name="setUiMode"][value="simple"]');
simple.checked = true;
simple.dispatchEvent(new window.Event('change', { bubbles: true }));
dump('after select 简洁版');

// switch back to full
const full = document.querySelector('input[name="setUiMode"][value="full"]');
full.checked = true;
full.dispatchEvent(new window.Event('change', { bubbles: true }));
dump('after select 完整版');
