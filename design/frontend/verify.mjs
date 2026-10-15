/* global console, process, document, navigator, localStorage, getComputedStyle */
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {previewServer} from './serve.mjs';
const root=dirname(fileURLToPath(import.meta.url));
await mkdir(join(root,'screenshots'),{recursive:true});
const server=previewServer(0);
await new Promise(r=>server.listening?r():server.once('listening',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const results=[],errors=[],requests=[],shots=[];
let browser;
try{
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1,reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']});
  const page=await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>requests.push({url:r.url(),method:r.method()}));
  const check=async(name,fn)=>{try{await fn();results.push({name,status:'PASS'});}catch(e){results.push({name,status:'FAIL',detail:e.message});console.error(name,e.message);}};
  const goto=async(state='default')=>{await page.goto(`${origin}/?state=${state}`);await page.locator('#scenario').waitFor();};
  const pick=async(state)=>page.selectOption('#scenario',state);
  const click=async(action)=>page.locator(`.payload-toolbar [data-action="${action}"]`).click();
  const screenshot=async(name)=>{await page.mouse.move(5,5);await page.locator('#toast').evaluate(el=>el.hidden=true);await page.screenshot({path:join(root,'screenshots',name)});shots.push(name);};
  await goto();
  const scenarios=await page.locator('#scenario option').evaluateAll(es=>es.map(e=>e.value));
  for(const size of [{width:1440,height:900},{width:1280,height:720},{width:1920,height:1080}]){
    await page.setViewportSize(size);
    for(const s of scenarios){
      await page.evaluate(()=>localStorage.clear());
      await goto(s);
      await check(`${size.width}×${size.height} / ${s} 布局与边界`,async()=>{
        const metrics=await page.evaluate(()=>{
          const rect=q=>document.querySelector(q).getBoundingClientRect().toJSON();
          const ws=document.querySelector('.workspace'),vp=document.querySelector('#views-viewport');
          return {left:rect('.left-pane'),right:rect('.payload-pane'),canvas:rect('.canvas'),program:rect('.program-section'),output:rect('.output-section'),submit:rect('.payload-toolbar [data-action="submit"]'),demo:rect('.demo-bar'),bodyWidth:document.documentElement.scrollWidth,bodyHeight:document.documentElement.scrollHeight,gap:getComputedStyle(ws).gap,slots:[...vp.children].filter(e=>e.classList.contains('view-slot')).map(e=>e.getBoundingClientRect().height),vp:vp.clientHeight,flag:!!document.querySelector('.flag'),timeline:!!document.querySelector('.replay')};
        });
        assert.ok(Math.abs(metrics.left.width-metrics.right.width)<1,'两半等宽');
        assert.equal(metrics.left.right,metrics.right.left,'两半无间隙');
        assert.equal(metrics.gap,'0px');
        assert.ok(metrics.bodyWidth<=size.width,'页面无横向溢出');
        assert.ok(metrics.bodyHeight<=size.height,'页面无纵向溢出');
        assert.ok(metrics.canvas.height>45,'画布仍有可滚动空间');
        assert.ok(metrics.program.height>=85&&metrics.output.height>=85,'程序与输出可见');
        assert.ok(metrics.submit.right<=size.width&&metrics.submit.bottom<metrics.demo.top,'提交按钮未被遮挡');
        if(metrics.slots.length)assert.ok(Math.abs(metrics.slots[0]*2-metrics.vp)<2,'两槽位等高');
        assert.equal(metrics.flag,s==='won','只有正式通过显示示例 flag');
        assert.equal(metrics.timeline,['won','incomplete','failed','rejected'].includes(s),'时间线只属于结果模式');
      });
      if(size.width===1440||s==='default'||s==='won'||s==='long')await screenshot(`${s}-${size.width}x${size.height}.png`);
    }
  }
  await page.setViewportSize({width:1440,height:900});
  await goto();
  await check('题面折叠、手动提示与本地记忆',async()=>{
    await page.evaluate(()=>localStorage.clear());await page.reload();
    await page.click('#brief-button');assert.equal(await page.locator('#brief-content').count(),0);
    await page.click('#brief-button');await page.click('#hints-button');
    for(let i=0;i<3;i++)await page.click('#next-hint');
    assert.ok(await page.locator('#next-hint').isDisabled());await page.reload();
    assert.match(await page.locator('#hints-button').textContent(),/3 \/ 3/);
    await page.evaluate(()=>localStorage.clear());
  });
  await goto();
  await check('视图隐藏、键盘排序、拖拽排序与快捷键',async()=>{
    await page.click('#view-menu-button');await page.uncheck('#show-stack');assert.equal(await page.locator('[data-view-slot="stack"]').count(),0);
    await page.check('#show-stack');await page.locator('[data-move="registers"][data-direction="-1"]').click();
    assert.equal(await page.locator('.view-slot').nth(1).getAttribute('data-view-slot'),'registers');
    await page.locator('[data-drag="memory"]').dragTo(page.locator('[data-drag="stack"]'));
    assert.equal(await page.locator('.view-slot').first().getAttribute('data-view-slot'),'memory');
    await page.keyboard.press('Escape');assert.equal(await page.locator('.popover').count(),0);
    await page.locator('#views-viewport').focus();await page.keyboard.press('Control+ArrowDown');await page.waitForTimeout(200);
    assert.ok(await page.locator('#views-viewport').evaluate(e=>e.scrollTop)>0);
  });
  await goto();
  await check('产物过期阻止执行；重新编译恢复',async()=>{
    const old=await page.locator('.program-row').first().textContent();
    await page.selectOption('#padding-count','24');
    for(const a of ['run','step','submit'])assert.ok(await page.locator(`.payload-toolbar [data-action="${a}"]`).isDisabled());
    assert.equal(await page.locator('.program-row').first().textContent(),old,'旧产物保留');
    await click('compile');assert.ok(await page.locator('.payload-toolbar [data-action="submit"]').isEnabled());
    assert.notEqual(await page.locator('.program-row').first().textContent(),old);
  });
  await goto('error');
  await check('编译错误定位与修正',async()=>{
    await page.locator('.output-body [data-locate="block-write"]').click();
    assert.equal(await page.evaluate(()=>document.activeElement.id),'block-write');
    assert.ok(await page.locator('#block-write').evaluate(e=>e.classList.contains('error-block')));
    await page.click('[data-action="fix-error"]');await click('compile');assert.equal(await page.locator('.program-row').count(),3);
  });
  await goto();
  await check('等待锁、单步、撤销、重置',async()=>{
    assert.ok(await page.locator('.payload-toolbar [data-action="back"]').isDisabled());
    await click('step');assert.ok(await page.locator('.payload-toolbar [data-action="run"]').isDisabled());
    await page.waitForTimeout(650);assert.match(await page.locator('.program-section .section-head').innerText(),/位置 2/);
    await click('undo');assert.match(await page.locator('.program-section .section-head').innerText(),/位置 1/);
    await click('run');await page.waitForTimeout(650);assert.match(await page.locator('.program-section .section-head').innerText(),/已执行完/);
    await click('reset');assert.match(await page.locator('.program-section .section-head').innerText(),/位置 1/);
    await click('undo');assert.match(await page.locator('.program-section .section-head').innerText(),/已执行完/);
  });
  await goto();
  await check('逐指令回退不新增请求历史',async()=>{
    await click('run');await page.waitForTimeout(650);
    assert.match(await page.locator('.source-bar').innerText(),/2 条指令/);
    await click('back');assert.match(await page.locator('.source-bar').innerText(),/1 条指令/);
    await click('back');assert.match(await page.locator('.source-bar').innerText(),/0 条指令/);
    assert.ok(await page.locator('.payload-toolbar [data-action="back"]').isDisabled());
    assert.match(await page.locator('.program-section .section-head').innerText(),/已执行完/);
    await click('undo');assert.match(await page.locator('.program-section .section-head').innerText(),/位置 1/);
    assert.ok(await page.locator('.payload-toolbar [data-action="undo"]').isDisabled());
  });
  await goto('empty');
  await check('空程序执行采用 VM 调试语义',async()=>{
    await click('compile');assert.match(await page.locator('.program-section .section-head').innerText(),/0 个动作/);
    await click('step');await page.waitForTimeout(650);
    assert.match(await page.locator('.output-body').innerText(),/payload 用完，提交 VM step/);
    assert.match(await page.locator('.program-section .section-head').innerText(),/0 个动作 · 已执行完/);
  });
  await goto('registers');
  await check('同一投影的菜单重绘不重复闪亮',async()=>{
    await page.click('#view-menu-button');
    assert.ok(await page.locator('.changed').count()>0);
    assert.ok(await page.locator('.changed').evaluateAll(es=>es.every(e=>getComputedStyle(e).animationName==='none')));
  });
  await goto('satisfied');
  await check('调试满足条件仍可操作且无 flag',async()=>{
    assert.match(await page.locator('.output-body').innerText(),/当前状态已满足成功条件/);
    assert.equal(await page.locator('.flag').count(),0);
    for(const a of ['run','step','nstep','submit'])assert.ok(await page.locator(`.payload-toolbar [data-action="${a}"]`).isEnabled());
  });
  await check('四种结果、回放拖动、返回调试完全保留状态',async()=>{
    const before=await page.locator('.source-bar,.statusbar,.program-section').allTextContents();
    for(const result of ['won','incomplete','failed','rejected']){
      await pick(result);assert.equal(await page.locator('#replay-frame').inputValue(),result==='rejected'?'2':'3');
      const slider=page.locator('#replay-frame'),box=await slider.boundingBox();
      await page.mouse.move(box.x+box.width-8,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+8,box.y+box.height/2,{steps:8});await page.mouse.up();
      assert.equal(await slider.inputValue(),'0');assert.match(await page.locator('.source-bar').textContent(),/帧 0/);
      assert.match(await page.locator('.tag.green').allTextContents().then(x=>x.join(' ')),/0x400000/);
      await page.locator('.replay [data-action="return"]').click();
      assert.deepEqual(await page.locator('.source-bar,.statusbar,.program-section').allTextContents(),before);
    }
  });
  await goto('stale');
  await check('错误/过期编辑状态不污染判题快照；返回仍为过期',async()=>{
    await pick('won');assert.match(await page.locator('.program-section').innerText(),/编译成功/);
    await page.click('#mode-debug');assert.match(await page.locator('.program-section').innerText(),/已过期/);
    assert.equal(await page.locator('#padding-count').inputValue(),'24');
  });
  await goto();
  await check('提交完整样例进入独立结果；返回保持调试位置',async()=>{
    await click('step');await page.waitForTimeout(650);const before=await page.locator('.source-bar,.statusbar').allTextContents();
    await click('submit');await page.waitForTimeout(750);assert.ok(await page.locator('.replay').isVisible());
    await page.locator('.replay [data-action="return"]').click();assert.deepEqual(await page.locator('.source-bar,.statusbar').allTextContents(),before);
  });
  await goto('io');
  await check('I/O 切换、隐藏/未映射区分、动作过滤',async()=>{
    assert.equal(await page.locator('[data-view-slot="io"]').count(),1);assert.match(await page.locator('.memory-box').innerText(),/\?\?/);
    assert.match(await page.locator('[data-view-slot="memory"]').innerText(),/未映射/);
    await page.click('#stdout-toggle');assert.match(await page.locator('[data-view-slot="io"]').innerText(),/72 65 61 64 79 0a/);
    await page.click('[data-category="动作"]');assert.equal(await page.locator('[data-tool="feed"]').count(),1);
    await goto();await page.click('[data-category="动作"]');assert.equal(await page.locator('[data-tool="feed"]').count(),0);
    assert.equal(await page.locator('[data-view-slot="io"]').count(),0);
  });
  await goto('registers');
  await check('寄存器复制、地址跳转与字节搜索',async()=>{
    await page.locator('[data-copy="0x7fffff20"]').click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'0x7fffff20');
    await page.fill('#jump-address','0x80000000');await page.press('#jump-address','Enter');assert.match(await page.locator('#stack-scroll .memory-box').innerText(),/隐藏/);
    await page.fill('#jump-address','0x90000000');await page.press('#jump-address','Enter');assert.match(await page.locator('#stack-scroll').innerText(),/未映射/);
    await page.fill('#stack-search','41 41');await page.press('#stack-search','Enter');assert.ok(await page.locator('.highlight-row').count()>0);
    await page.selectOption('#search-kind','ASCII');await page.fill('#stack-search','AA');await page.press('#stack-search','Enter');assert.ok(await page.locator('.highlight-row').count()>0);
  });
  await goto('no-challenges');
  await check('无可用题目有独立空态与刷新入口',async()=>{
    assert.match(await page.locator('.briefing h1').innerText(),/暂无可用题目/);
    assert.equal(await page.locator('#block-start').count(),0);
    for(const a of ['compile','run','step','nstep','submit'])assert.ok(await page.locator(`.payload-toolbar [data-action="${a}"]`).isDisabled());
    await page.click('[data-action="refresh-challenges"]');assert.match(await page.locator('#announcer').innerText(),/列表仍为空/);
  });
  await goto('expired');
  await check('会话恢复保留画布、清空调试历史',async()=>{
    assert.ok(await page.locator('.payload-toolbar [data-action="compile"]').isDisabled());
    await page.locator('.banner [data-action="restart"]').click();assert.equal(await page.locator('.banner').count(),0);
    assert.ok(await page.locator('#block-start').isVisible());assert.ok(await page.locator('.payload-toolbar [data-action="back"]').isDisabled());
  });
  await goto('hints');
  await check('提示阈值自动揭示',async()=>{assert.match(await page.locator('#hints-button').innerText(),/自动揭示/);assert.match(await page.locator('#hints-button').innerText(),/2 \/ 3/);});
  await goto();
  await check('键盘焦点、模式语义和状态播报',async()=>{
    await page.locator('#view-menu-button').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#view-menu-button').getAttribute('aria-expanded'),'true');
    assert.equal(await page.locator('#view-menu-button').evaluate(e=>getComputedStyle(e).outlineWidth),'2px');
    await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'view-menu-button');
    assert.equal(await page.locator('#mode-debug').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#announcer').getAttribute('aria-live'),'polite');
    await screenshot('keyboard-focus-1440x900.png');
  });
  await check('直接打开 file:// 入口',async()=>{
    await page.goto(pathToFileURL(join(root,'index.html')).href+'?state=error');assert.equal(await page.locator('#scenario').inputValue(),'error');
    assert.ok(await page.locator('#block-write.error-block').isVisible());await page.locator('.output-body [data-locate="block-write"]').click();
  });
  await check('零浏览器脚本错误',async()=>assert.deepEqual(errors,[]));
  await check('无外部资源/服务端执行请求',async()=>{
    assert.deepEqual(requests.filter(r=>!r.url.startsWith(origin)&&!r.url.startsWith('file:')&&!r.url.startsWith('data:')),[]);
    assert.deepEqual(requests.filter(r=>r.method!=='GET'),[]);
  });
  const report={date:'2026-10-15',browser:`Microsoft Edge ${browser.version()}`,platform:process.platform,deviceScaleFactor:1,method:'Playwright 操作实际浏览器；截图直接来自页面，未进行人工视觉审查',passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,results,screenshots:shots,consoleErrors:errors};
  await writeFile(join(root,'verification.json'),JSON.stringify(report,null,2)+'\n');
  await writeFile(join(root,'verification.md'),`# 原型验证记录\n\n日期：${report.date}。浏览器：${report.browser}；${report.platform}；DPR 1。\n\n${report.method}。结果：**${report.passed} 项通过，${report.failed} 项失败**。\n\n| 检查 | 结果 |\n|---|---|\n${results.map(r=>`| ${r.name} | ${r.status}${r.detail?'：'+r.detail.replaceAll('|','/').replaceAll('\n',' '):''} |`).join('\n')}\n\n未验证：Firefox / Safari、真实屏幕阅读器、真实 API、真实 Blockly 拖拽编译、真实 VM / 判题、G3 八步闭环。截图生成与几何断言不替代人工视觉审查。\n`);
  const titles=await page.locator('#scenario option').evaluateAll(es=>Object.fromEntries(es.map(e=>[e.value,e.textContent])));
  const cards=shots.map(name=>{
    const [,key,w,h]=name.match(/^(.*)-(\d+)x(\d+)\.png$/);
    const title=key==='keyboard-focus'?'键盘焦点':titles[key];
    return `<article><a href="${name}"><img loading="lazy" src="${name}" alt="${title}，${w}×${h}" width="${w}" height="${h}"></a><div><strong>${title}</strong><span>${w}×${h}</span></div><a href="../index.html?state=${key==='keyboard-focus'?'default':key}">打开对应交互状态 ↗</a></article>`;
  }).join('\n');
  await writeFile(join(root,'screenshots','index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pwn2Block · 状态截图</title><style>body{margin:0;padding:32px;background:#0b120d;color:#d7e4d9;font:14px/1.7 Consolas,"Microsoft YaHei",monospace}header{max-width:1000px;margin-bottom:28px}h1{font-size:24px}a{color:#90c99d}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,540px),1fr));gap:24px}article{padding:12px;background:#152219;border:1px solid #344a3a;border-radius:8px}img{display:block;width:100%;height:auto}article div{display:flex;justify-content:space-between;margin:10px 0}a:focus-visible{outline:2px solid #80bfff;outline-offset:3px}p{color:#a9bdad}</style><header><h1>Pwn2Block / 关键状态截图</h1><p>2026-10-15 · ${shots.length} 张实际浏览器截图 · ${report.browser} · DPR 1。点击图片查看原尺寸。截图对应独立打开的预设场景；四种判题结果可返回当前调试样例。</p><p>公开合成数据，执行和判题均为预设。由 Playwright 截取，未作人工视觉审查。</p><a href="../index.html">打开交互原型</a> · <a href="../verification.md">验证记录</a> · <a href="../README.md">说明</a></header><main>${cards}</main></html>`);
  console.log(JSON.stringify({passed:report.passed,failed:report.failed,screenshots:shots.length,browser:report.browser}));
  if(report.failed)process.exitCode=1;
}finally{await browser?.close();await new Promise(r=>server.close(r));}
