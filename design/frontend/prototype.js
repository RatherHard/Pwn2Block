/* global window, document, location, requestAnimationFrame */
/* 独立设计原型：编译、执行与判题仅选择预设反馈；无 VM、真实编译器或 API。 */
(() => {
  'use strict';
  const D = window.P2B_DEMO;
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const names = {stack:'栈',disasm:'指令',registers:'寄存器',memory:'自由内存',io:'I/O'};
  const codes = {stack:'STACK',disasm:'DISASSEMBLY',registers:'REGISTERS',memory:'MEMORY',io:'INPUT / OUTPUT'};
  const hintKey = `p2b-design:hints:${D.challenge.id}`;
  let savedHints = 0;
  try { savedHints = Math.max(0, Math.min(3, Number(localStorage.getItem(hintKey)) || 0)); } catch { /* 存储不可用时仅内存降级 */ }
  let state = {
    scenario:'default', mode:'debug', debug:{frame:0,cursor:0,status:'ready',undo:0,stepBack:0,failures:0},
    verdict:null, frame:0, compiled:'ready', compiledPadding:16, padding:16, selected:null, category:null,
    order:['stack','disasm','registers','memory'], shown:['stack','disasm','registers','memory'], io:false,
    briefing:true, hintsOpen:false, hints:savedHints, autoHint:false, menu:null,
    memory:'key', stdoutHex:false, offset:0, search:'', searchKind:'hex', jump:'', marked:null,
    waiting:false, waitingPreview:false, session:'active', n:2, historyWindow:false,
    log:'公开样例已就绪。先观察栈，再把你的思路连接到开始积木。',long:false, empty:false, requestId:0
  };
  const app = $('#app');
  function tell(text) {
    $('#announcer').textContent = text;
    const toast = $('#toast'); toast.textContent = text; toast.hidden = false;
    clearTimeout(tell.timer); tell.timer = setTimeout(() => { toast.hidden = true; }, 3200);
  }
  function saveHints() { try { localStorage.setItem(hintKey, String(state.hints)); } catch { /* 非关键本地记忆 */ } }
  function autoHints() {
    const n = D.challenge.hints.reduce((count,h,i) => h.unlockAfterFailures && state.debug.failures >= h.unlockAfterFailures ? i+1 : count, state.hints);
    if (n > state.hints) { state.hints = n; state.autoHint = true; state.hintsOpen = true; saveHints(); tell(`已自动揭示第 ${n} 条提示，公开 failures 已达到阈值。`); }
  }
  function frame() {
    if (state.mode === 'debug') return D.frames[state.debug.frame];
    return D.frames[state.verdict === 'rejected' && state.frame === 2 ? 1 : state.frame];
  }
  function actions() {
    if(state.empty)return [];
    const list = D.programs[state.compiledPadding].map(a => ({...a}));
    if (state.mode === 'verdict' && state.verdict === 'rejected') list[1].addr = '0x80000000';
    return state.long ? Array.from({length:96},(_,i) => ({...list[i%3]})) : list;
  }
  const statusText = () => ({ready:'可继续执行',satisfied:'已满足成功条件',failed:'运行失败',exited:'程序已结束'}[state.debug.status]);
  function disabledReason(a) {
    if(state.session==='no-challenges')return '暂无可用题目，请刷新题目列表';
    if(state.mode!=='debug')return '正在查看判题录像；回到调试后操作';
    if(state.session!=='active')return '会话不可用，请重新开始';
    if(state.waiting)return '请求处理中，请等待返回';
    if(a==='compile')return '';
    if(a==='back')return state.debug.stepBack>0?'':state.historyWindow?'已退到最近 64 条指令窗口之外':'指令历史为空';
    if(a==='undo')return state.debug.undo>0?'':'请求历史为空';
    if(a==='reset')return '';
    if(['run','step','submit'].includes(a)&&state.compiled!=='ready')return state.compiled==='stale'?'已过期，请重新编译':'请先完成编译';
    if(['run','step','nstep'].includes(a)&&['failed','exited'].includes(state.debug.status))return '实例已停止；请后退、撤销或重置';
    return '';
  }
  function button(a,label,cls='',description='') {
    const reason=disabledReason(a);
    return `<button data-action="${a}" class="${cls}" ${reason?'disabled':''} title="${esc(reason||description||label.replace(/<[^>]*>/g,''))}">${label}</button>`;
  }
  function header() {
    return `<header class="topbar"><div class="brand"><span class="brand-symbol" aria-hidden="true">&gt;_</span><div>Pwn2Block<small>内存可视化实验室</small></div></div><span class="top-divider"></span><div class="top-title"><span>${state.session==='no-challenges'?'题目列表':'01 / 栈上的第一步'}</span><small>公开教学样例</small></div><nav aria-label="主菜单"><div class="menu-wrap"><button id="view-menu-button" data-menu="views" class="subtle" aria-expanded="${state.menu==='views'}" aria-controls="views-menu">视图 ▾</button>${state.menu==='views'?viewMenu():''}</div><div class="menu-wrap"><button id="run-menu-button" data-menu="run" class="subtle" aria-expanded="${state.menu==='run'}" aria-controls="run-menu">运行 ▾</button>${state.menu==='run'?runMenu():''}</div></nav><span class="spacer"></span><div class="segmented" role="group" aria-label="当前工作模式"><button id="mode-debug" data-mode="debug" aria-pressed="${state.mode==='debug'}" class="${state.mode==='debug'?'selected':''}"><span class="mode-icon">●</span>调试模式</button><button id="mode-verdict" data-mode="verdict" aria-pressed="${state.mode==='verdict'}" class="${state.mode==='verdict'?'selected':''}" ${!state.verdict?'disabled title="提交后可查看判题结果"':''}>判题结果</button></div></header>`;
  }
  function viewMenu() {
    return `<div id="views-menu" class="popover" aria-label="视图显示与排序"><p><strong>管理视图</strong><span class="dim small"> · 拖动或用箭头排序</span></p>${state.order.map((v,i)=>`<div class="view-item" draggable="true" data-drag="${v}"><span class="drag-handle" aria-hidden="true">⠿</span><label><input type="checkbox" id="show-${v}" data-view="${v}" ${state.shown.includes(v)?'checked':''}>${names[v]}</label><button class="compact" data-move="${v}" data-direction="-1" aria-label="上移${names[v]}" ${i===0?'disabled':''}>↑</button><button class="compact" data-move="${v}" data-direction="1" aria-label="下移${names[v]}" ${i===state.order.length-1?'disabled':''}>↓</button></div>`).join('')}<p class="dim small" style="margin:10px 0 0">同时显示两个槽位 · Ctrl+↑ / Ctrl+↓</p>${!state.io?'<p class="dim small">本题未声明 syscalls / fds，I/O 不显示。</p>':''}</div>`;
  }
  function runMenu() {
    const list=[['compile','编译','只生成本地动作序列'],['run','试运行','剩余 payload 动作；用完后 run'],['step','单步','下一个 payload 动作；用完后 VM step'],['nstep',`运行 ${state.n} 步`,'step 携带 count'],['back','后退一步','回退一条指令，最近 64 条内'],['undo','撤销','回退上一次请求'],['reset','重置','回到初态'],['submit','提交判题','完整 payload → 独立判题实例']];
    return `<div id="run-menu" class="popover run-list">${list.map(([a,t,d])=>button(a,`${t}<small>${d}</small>`,a==='submit'?'primary':'',d)).join('')}</div>`;
  }
  function briefing() {
    if(state.session==='no-challenges')return '<section class="briefing" aria-label="题目列表"><div class="brief-head"><span class="eyebrow">题目列表</span><h1>暂无可用题目</h1><span class="spacer"></span><button data-action="refresh-challenges">刷新题目列表</button></div><p class="dim small">当前公开题目列表为空。题目可用后，再创建调试会话。</p></section>';
    return `<section class="briefing ${state.briefing?'':'collapsed'}" aria-label="题面与提示"><div class="brief-head"><span class="eyebrow">实验 01</span><h1>栈上的第一步</h1><span class="tag">64 位 · 小端序</span><span class="tag green">基础 / 栈帧</span><span class="spacer"></span><button id="hints-button" data-action="hints" class="subtle compact" aria-expanded="${state.hintsOpen}" aria-controls="hints-panel">提示 ${state.hints} / 3 ${state.autoHint?'· 自动揭示':''}</button><button id="brief-button" data-action="brief" class="subtle compact" aria-expanded="${state.briefing}" aria-controls="brief-content">${state.briefing?'收起题面 ⌃':'展开题面 ⌄'}</button></div>${state.briefing?`<div id="brief-content" class="brief-body"><p class="brief-text">一次函数返回，会把控制流带向哪里？观察 <code>buffer</code>、<code>saved_bp</code> 和 <code>ret_addr</code>，用积木构造字节，理解栈上相邻数据的关系。<br><span class="dim">先在调试实例中尝试，再提交完整 payload，从初始状态验证你的思路。</span>${state.long?'<br>'+('长题面示例：观察公开地址、逐步验证偏移，并记录每一次变化。'.repeat(12)):''}</p><span class="spacer"></span><span class="tag">教学用 VM / 非真实系统</span></div>`:''}${state.hintsOpen?`<div id="hints-panel" class="hints">${D.challenge.hints.map((h,i)=>`<div class="hint-row ${i>=state.hints?'hint-locked':''}"><span class="hint-num">0${i+1}</span>${i<state.hints?esc(h.text):'尚未揭示'+(h.unlockAfterFailures?` · failures ≥ ${h.unlockAfterFailures} 时自动揭示`:'')}</div>`).join('')}<div class="hint-actions"><button id="next-hint" data-action="hint-next" ${state.hints===3?'disabled':''}>${state.hints===3?'全部提示已揭示':'下一条提示'}</button><span class="dim small">不扣分 · 按题目保存在本机</span></div></div>`:''}</section>`;
  }
  function sourceBar() {
    if(state.session==='no-challenges')return '<div class="source-bar"><span class="source-label">◇ 尚未建立会话</span><span class="dim">等待可用题目</span></div>';
    const label=state.mode==='debug'?'调试实例 / 当前公开投影':`判题录像 / 帧 ${state.frame} · ${state.frame===0?'初始投影':'逐动作投影'}`;
    return `<div class="source-bar ${state.mode==='verdict'?'verdict':''}"><span class="source-label">${state.mode==='debug'?'●':'◉'} ${label}</span><span class="dim">${state.mode==='debug'?statusText():'只读回放'} · ${frame().steps} 条指令</span><span class="spacer"></span><span class="dim">${state.waiting?'◌ 请求处理中 · 操作暂不可用':'公开内容可见 · 隐藏内容不下发'}</span></div>`;
  }
  function banner() {
    if(['expired','network'].includes(state.session))return `<section class="banner error" role="status"><span class="banner-symbol">!</span><div><h2>会话已失效</h2><p>${state.session==='network'?'网络连接失败，当前投影保留供查看。':'404 · 会话不存在或已过期。'} 重新开始会创建新的调试会话，画布保留。</p></div><span class="spacer"></span><button data-action="restart">重新开始</button></section>`;
    if(state.mode!=='verdict')return '';
    const v=D.verdicts[state.verdict];
    return `<section class="banner ${v.tone}" aria-label="判题结论"><span class="banner-symbol">${v.symbol}</span><div><h2>${v.title}<span class="tag" style="margin-left:10px">${state.verdict}</span></h2><p>${v.detail}</p></div>${state.verdict==='won'?'<div class="flag"><small>示例，非真实 flag · 真实通过后复制到 CTF 平台</small><code>DEMO{public_design_sample}</code> <button data-copy="DEMO{public_design_sample}" class="compact">复制</button></div>':'<span class="spacer"></span>'}<button data-action="return">回到调试 ↗</button></section>`;
  }
  function stackRows() {
    const f=frame();
    const bytes=[...Array(16).fill(f.buffer),...'40 ff ff 7f 00 00 00 00'.split(' '),...`${f.ret} 00 40 00 00 00 00 00`.split(' '),...'00 ff ff 7f 00 00 00 00'.split(' '),...Array(16).fill('00')];
    return Array.from({length:6},(_,i)=>{
      const start=i*8+state.offset,addr=`0x${(0x7fffff00+start).toString(16)}`,b=bytes.slice(start,start+8);while(b.length<8)b.push('00');
      const kind=start<16?'buffer':start<24?'saved':start<32?'ret':'custom',label=start<16?'buffer':start<24?'saved_bp':start<32?'ret_addr':start<40?'custom / next':'栈空间';
      return {addr,bytes:b,kind,label,ascii:b.map(h=>{const n=parseInt(h,16);return n>=32&&n<127?String.fromCharCode(n):'·';}).join(''),value:`0x${[...b].reverse().join('')}`};
    });
  }
  function stackView() {
    const f=frame();
    return `<div class="view-tools"><label for="jump-address" class="sr-only">跳转到公开地址</label><input id="jump-address" type="text" placeholder="0x7fffff18" value="${esc(state.jump)}"><button data-action="jump">跳转</button><label for="stack-offset" class="dim">对齐</label><select id="stack-offset" class="offset">${Array.from({length:8},(_,i)=>`<option value="${i}" ${state.offset===i?'selected':''}>+${i}</option>`).join('')}</select><span class="spacer"></span><label for="search-kind" class="sr-only">搜索格式</label><select id="search-kind"><option ${state.searchKind==='hex'?'selected':''}>hex</option><option ${state.searchKind==='ASCII'?'selected':''}>ASCII</option></select><label for="stack-search" class="sr-only">搜索字节</label><input id="stack-search" type="text" value="${esc(state.search)}" placeholder="搜索字节"><button data-action="search">查找</button></div><div class="table-scroll" id="stack-scroll"><table class="data-table"><thead><tr><th>地址 / 锚点</th><th>字节 · 每行 8 B</th><th>ASCII</th><th>语义 / 值</th></tr></thead><tbody>${stackRows().map(r=>`<tr data-address="${r.addr}" class="stack-row ${r.kind} ${state.marked===r.addr?'highlight-row':''} ${r.addr===f.sp?'sp-row':''}"><td class="address"><span class="anchor">${r.addr===f.sp?'sp →':r.addr===f.bp?'bp →':''}</span>${r.addr}</td><td class="bytes ${f.buffer==='41'&&r.kind==='buffer'?'changed':''}">${r.bytes.join(' ')}${f.buffer==='41'&&r.kind==='buffer'?'<span class="changed-mark">Δ</span>':''}</td><td class="ascii">${esc(r.ascii)}</td><td><span class="tag ${r.kind==='ret'?'purple':r.kind==='saved'?'yellow':''}">${r.label}</span><div class="cell-note" title="${r.value}">${r.kind==='ret'?`<button class="link-button" data-target="${f.ret==='02'?'0x400002':'0x400003'}">→ ${f.ret==='02'?'0x400002':'0x400003'}</button>`:r.kind==='custom'&&r.label.includes('next')?'<button class="link-button" data-action="pointer">→ 指针链 · 2 跳</button>':r.value}</div></td></tr>`).join('')}</tbody></table>${state.marked==='pointer'?'<div class="pointer-chain">公开链 · 0x7fffff20 → 0x7fffff00 → 可见字节<br>公开指针 · ret_addr → 0x400002 → <code>syscall win</code><br><span class="dim">最多 3 跳；进入隐藏或未映射区域即停止。</span></div>':''}${state.marked==='hidden'?'<div class="memory-box">0x80000000 · key · 隐藏<br>?? ?? ?? ?? ?? ?? ?? ??<p>只显示布局，内容不在公开投影中。</p></div>':''}${state.marked==='unmapped'?'<div class="pointer-chain">未映射地址 · <span class="dim">内容为空（—），与隐藏字节 ?? 不同。</span></div>':''}</div><div class="view-foot legend"><span><i style="background:#a9c5e7"></i>buffer</span><span><i style="background:#d7c297"></i>saved_bp</span><span><i style="background:#cfb1ec"></i>ret_addr</span><span class="spacer"></span><span>跟随 sp · W = 8 字节</span></div>`;
  }
  function disasmView() {
    return `<div class="view-tools"><label for="function-select" class="dim">函数</label><select id="function-select">${D.functions.map(f=>`<option value="${f.addr}" ${state.marked===f.addr?'selected':''}>${f.name} · ${f.addr}</option>`).join('')}</select><span class="spacer"></span><span class="tag green">ip · ${frame().ip}</span></div><div class="table-scroll" id="disasm-scroll"><table class="data-table"><thead><tr><th>地址</th><th>机器码</th><th>伪汇编</th></tr></thead><tbody>${D.disasm.map(d=>`<tr data-address="${d.addr}" class="${frame().ip===d.addr?'current-row':''} ${state.marked===d.addr?'highlight-row':''}"><td class="address">${frame().ip===d.addr?'→ ':''}${d.addr}</td><td class="dim">${d.bytes}</td><td><code>${esc(d.text)} ${d.target?`<button class="link-button" data-target="${d.target}">${d.target}</button>`:''}</code><span class="cell-note" style="margin-left:16px">; ${d.comment}</span></td></tr>`).join('')}</tbody></table></div><div class="view-foot">伪汇编来自公开投影 · 点击跳转目标定位 · 跟随 ip</div>`;
  }
  function registersView() {
    const f=frame(),regs=[['RAX','0x0'],['RDI','0x0'],['RSP',f.sp],['RBP',f.bp],['RIP',f.ip],['FLAG','0x0']];
    return `<div class="register-grid">${regs.map(([name,value])=>`<div class="register-cell"><span>${name} ${['RSP','RBP','RIP'].includes(name)?`<span class="tag">${name==='RSP'?'sp':name==='RBP'?'bp':'ip'}</span>`:''}</span><button data-copy="${value}" class="subtle ${f.steps&&['RSP','RBP','RIP'].includes(name)?'changed':''}" title="复制 ${name} 的值">${value}${f.steps&&['RSP','RBP','RIP'].includes(name)?' Δ':''}</button></div>`).join('')}</div><div class="flags"><span>ZF <strong>0</strong></span><span>CF <strong>0</strong></span><span>SF <strong>0</strong></span><span class="spacer"></span><span class="dim">点击值复制</span></div><div class="view-foot">所有公开寄存器 · Δ 本次变化 · 名称由题目决定</div>`;
  }
  function memoryView() {
    return `<div class="table-scroll"><div class="vma-list">${D.vmas.map(v=>`<button class="vma ${state.memory===v.id?'selected':''}" data-vma="${v.id}"><span>${v.id}</span><span class="tag">${v.kind}</span><span>${v.label}</span><span class="range">${v.start}–${v.end}</span><span>${v.perm}</span>${v.hidden?'<span class="tag purple">隐藏</span>':''}</button>`).join('')}</div>${state.memory==='key'?'<div class="memory-box"><strong>◇ key / 隐藏 VMA</strong><p>0x80000000 · ?? ?? ?? ?? ?? ?? ?? ??</p><p>只展示范围、权限与隐藏标记。未下发字节，无法读取或沿指针继续。</p></div>':`<table class="data-table"><thead><tr><th>地址</th><th>公开字节</th><th>ASCII</th></tr></thead><tbody>${state.memory==='stack'?stackRows().slice(0,4).map(r=>`<tr><td>${r.addr}</td><td>${r.bytes.join(' ')}</td><td>${esc(r.ascii)}</td></tr>`).join(''):D.disasm.slice(0,3).map(d=>`<tr><td>${d.addr}</td><td>${d.bytes}</td><td>·</td></tr>`).join('')}</tbody></table>`}<div class="pointer-chain"><span class="dim">未映射对照 · 0x90000000</span><br>内容：— <span class="dim">（无映射，显示为空）</span></div></div><div class="view-foot">VMA 范围 [start, end) · 只浏览投影已有内容</div>`;
  }
  function ioView() {
    const f=frame();
    return `<div class="table-scroll"><div class="io-block"><div style="display:flex;align-items:center">stdout <span class="tag green" style="margin-left:8px">${f.stdout?'新增 6 B':'空'}</span><span class="spacer"></span><button id="stdout-toggle" data-action="stdout" class="compact">${state.stdoutHex?'查看 ASCII':'查看 hex'}</button></div><div class="io-line ${f.stdout?'changed':''}">${f.stdout?(state.stdoutHex?'72 65 61 64 79 0a':esc(f.stdout)+'↵'):'暂无输出'}</div></div><div class="io-block">stdin <span class="dim">· pos = ${f.stdinPos} / 8 B</span><div class="io-line"><span class="consumed">${f.stdinPos?'41 41 41 41':''}</span>${f.stdinPos?' 42 42 42 42':'41 41 41 41 42 42 42 42'} <span class="dim">← ${f.stdinPos?'前 4 字节已读':'尚未读取'}</span></div></div><div class="dim small">syscall ABI · nr: RAX / args: RDI, RSI, RDX / ret: RAX</div><table class="data-table abi-table"><thead><tr><th>调用号 / 名称</th><th>公开说明</th></tr></thead><tbody><tr><td>0 / read</td><td>从虚拟 fd 读取字节</td></tr><tr><td>1 / write</td><td>向 stdout 写入字节</td></tr></tbody></table><p class="dim small">fd 0 · stdin / 可读  fd 1 · stdout / 可写</p></div><div class="view-foot">本样例声明 syscalls 与 fds；仅在声明存在时展示 I/O</div>`;
  }
  function views() {
    if(state.session==='no-challenges')return '<section class="left-pane" aria-label="内存视图管理器"><div class="section-head"><h2>内存观察</h2><span class="dim">暂无公开投影</span></div><div class="views-viewport" id="views-viewport"><div class="empty-panel"><span class="empty-icon">◇</span><strong>题目尚未就绪</strong><p>公开题目列表为空，暂时无法创建调试实例。</p></div></div></section>';
    const visible=state.order.filter(v=>state.shown.includes(v));
    return `<section class="left-pane" aria-label="内存视图管理器"><div class="section-head"><span class="section-number">01</span><h2>内存观察</h2><span class="dim">${visible.length} 个视图</span><span class="spacer"></span><span class="dim shortcut">Ctrl + ↑ / ↓</span><button data-action="views-prev" class="subtle compact" aria-label="上一个视图">↑</button><button data-action="views-next" class="subtle compact" aria-label="下一个视图">↓</button><button data-action="view-list" class="subtle compact" aria-label="打开视图列表">☷ 列表</button></div><div class="views-viewport" id="views-viewport" tabindex="0" aria-label="上下滚动切换视图">${visible.length?visible.map(v=>`<section class="view-slot" data-view-slot="${v}" aria-label="${names[v]}视图"><div class="view-heading"><h2>${names[v]}</h2><span class="view-code">${codes[v]}</span><span class="spacer"></span><span class="dim small">${v==='stack'?'stack · rw':v==='disasm'?'text · rx':'公开投影'}</span></div>${state.session==='loading'?'<div class="table-scroll" aria-busy="true"><div class="loading-line"></div><div class="loading-line"></div><div class="loading-line"></div><p class="dim small">正在加载公开投影…</p></div>':({stack:stackView,disasm:disasmView,registers:registersView,memory:memoryView,io:ioView}[v])()}</section>`).join(''):'<div class="empty-panel"><span class="empty-icon">☷</span><strong>还没有显示任何视图</strong><p>在“视图”菜单中选择想观察的内容。</p><button data-action="view-list">打开视图列表</button></div>'}</div></section>`;
  }
  function flyout() {
    if(!state.category)return '';
    const c=state.category,allowed=state.io?D.ioDeclaration.allowedActions:D.challenge.allowedActions;
    const items=c==='通用'?['变量 / 赋值','数值 / 算术 / 比较','条件 / if','循环 / repeat']:c==='字节'?['padding(byte, n)','string(s) · UTF-8','int(v, width, endian)','addr(v) · W 字节 / 小端','raw(hex)','concat(...)']:c==='动作'?allowed:D.challenge.authorBlocks.map(b=>b.label+' · bytes 输入槽');
    return `<aside class="flyout" aria-label="${c}工具箱"><div class="flyout-title"><strong>${c}</strong><button data-action="close-category" class="subtle compact" aria-label="关闭工具箱">×</button></div>${items.map(t=>`<button data-tool="${esc(t)}" title="${t==='feed'?'feed 必须放在触发 read 的 step / run 之前，否则先读到 EOF。':'静态外观展示；原型不创建真实 Blockly 积木。'}">${esc(t)}</button>`).join('')}<p>${c==='动作'?'动作按 allowedActions 过滤；feed 仅在 I/O 样例开放。':'变量与表达式仅在编译期求值。'}<br>工具箱用于检查外观与 tooltip；拼接和拖拽由 H 接入真实 Blockly。</p></aside>`;
  }
  function blockClass(id) {
    return `${state.selected===id?'selected-block ':''}${state.compiled==='error'&&id==='block-write'||state.mode==='verdict'&&state.verdict==='rejected'&&id==='block-address'?'error-block':''}`;
  }
  function canvas() {
    if(state.session==='no-challenges')return '<div class="canvas"><div class="empty-panel" style="flex:1"><strong>等待题目</strong><p>题目可用后将加载相应的积木工具箱。</p></div></div>';
    const locked=state.mode!=='debug'||state.waiting||state.session!=='active';
    return `<div class="canvas"><aside class="toolbox" aria-label="积木分类">${[['通用','generic'],['字节','bytes'],['动作','action'],['出题人积木','author']].map(([c,t])=>`<button data-category="${c}" class="${state.category===c?'active':''}" aria-expanded="${state.category===c}"><span class="category-dot" style="background:var(--block-${t})"></span>${c}</button>`).join('')}<div class="toolbox-bottom">一个开始块<br>自上向下执行</div></aside>${state.session==='loading'?'<div class="empty-panel" style="flex:1" aria-busy="true">正在准备画布…</div>':`<div class="block-stage" id="block-stage"><div class="blocks"><div class="block start" id="block-start" tabindex="0" data-block="block-start">▶ 开始 <span class="block-caption">唯一入口 · payload 从这里开始</span><span class="tooltip" role="tooltip">开始块唯一。只有连接到它的积木参与编译。</span></div>${state.empty?'':`<div class="block ${blockClass('block-write')}" id="block-write" tabindex="0" data-block="block-write">写入字节 <span class="slot">0x7fffff00</span><span class="nested">${state.compiled==='error'?(state.scenario==='limit'?'循环 repeat <span class="slot">257 次</span>':'原始字节 raw <span class="slot">4G</span>'):`填充 padding <span class="slot">0x41</span> × <select id="padding-count" aria-label="填充字节数（预设样例）" ${locked?'disabled':''}><option ${state.padding===16?'selected':''}>16</option><option ${state.padding===24?'selected':''}>24</option></select> 字节`}</span><span class="tooltip" role="tooltip">参数是编译期常量。更改参数会使已有产物过期。</span></div>${state.compiled==='error'?`<div class="error-bubble">! ${state.scenario==='limit'?'循环展开超过上限 256':'raw(hex) 含非法字符：4G'} · 点击输出定位</div>`:''}<div class="block ${blockClass('block-address')}" id="block-address" tabindex="0" data-block="block-address">写入字节 <span class="slot">${state.mode==='verdict'&&state.verdict==='rejected'?'0x80000000':'0x7fffff18'}</span><span class="nested">地址 addr <span class="slot">0x400002</span><span class="block-caption">W = 8 字节 · little endian</span></span><span class="tooltip" role="tooltip">只使用计算出的字面地址；不读取运行时寄存器或内存。</span></div><div class="block ${blockClass('block-run')}" id="block-run" tabindex="0" data-block="block-run">运行 run <span class="block-caption">执行直到停止条件或步数上限</span><span class="tooltip" role="tooltip">若使用 feed，必须放在触发读取的 step / run 之前。</span></div><div class="disconnected"><div class="block" tabindex="0" data-block="block-unused">字符串 string <span class="slot">"hello"</span><span class="tooltip" role="tooltip">未连接到开始块，不进入编译产物。</span></div><p>◇ 未连接 · 不参与编译</p></div>`}</div></div>`}${flyout()}<span class="canvas-badge">Blockly 外观原型 · 参数切换可用 / 拖拽拼接待接入</span></div>`;
  }
  function toolbar() {
    return `<div class="payload-toolbar">${button('compile','编译','','本地编译，不发送执行请求')}${button('run','▷ 试运行','','执行剩余 payload 动作；用完后提交 run')}${button('step','↳ 单步','','执行下一 payload 动作；用完后提交 VM step')}<span class="spacer"></span>${button('submit','提交判题 ↗','primary','完整 payload 从初态回放')}<div class="toolbar-secondary">${button('back','↶ 后退一步')}${button('undo','撤销')}${button('reset','重置')}<span class="dim">│</span><label for="step-count">步数</label><input id="step-count" type="number" value="${state.n}" min="1" max="10000" ${disabledReason('nstep')?'disabled':''}>${button('nstep','运行 N 步')}<span class="toolbar-note">${state.waiting?'◌ 等待响应':state.debug.stepBack?`可后退 ${state.debug.stepBack} 条`:state.historyWindow?'64 条窗口已用尽':'回退历史为空'}</span></div></div>`;
  }
  function program() {
    if(state.session==='no-challenges')return '<section class="program-section" aria-label="程序区"><div class="section-head"><h2>程序</h2><span class="dim">无可执行产物</span></div><div class="program-body"><p class="dim small">尚未选择题目。</p></div></section>';
    const label={ready:'编译成功',stale:'已过期',error:'编译失败',none:'尚未编译'}[state.compiled],cursor=state.mode==='debug'?state.debug.cursor:state.frame-1,hasActions=['ready','stale'].includes(state.compiled);
    return `<section class="program-section" aria-label="程序区"><div class="section-head"><h2>程序</h2><span class="tag ${state.compiled==='ready'?'green':state.compiled==='error'?'red':'yellow'}">${label}</span><span class="spacer"></span><span class="dim">${hasActions?`${actions().length} 个动作 · ${state.mode==='verdict'?(state.frame===0?'初始状态':`动作 ${state.frame}${state.frame===(state.verdict==='rejected'?2:3)?' · 录像结束':''}`):cursor>=actions().length?'已执行完':`位置 ${cursor+1}`}`:'无可执行产物'}</span></div><div class="program-body" id="program-body">${state.compiled==='stale'?'<div class="program-stale">△ 已过期，请重新编译 · 旧产物仅供对照，试运行与提交已禁用</div>':''}${!hasActions?`<div class="empty-panel" style="padding:10px"><span>${state.compiled==='error'?'! 编译失败，无可用动作序列':'连接积木后点击“编译”，在这里检查动作顺序。'}</span>${state.compiled==='error'?'<button data-locate="block-write" class="compact">定位出错积木</button>':''}</div>`:actions().map((a,i)=>`<button class="program-row ${cursor===i?'current':''} ${cursor>i?'done':''} ${state.mode==='verdict'&&state.verdict==='rejected'&&i===1?'has-error':''}" data-locate="${a.blockId}" aria-label="动作 ${i+1} ${a.type}，定位对应积木"><span class="line-no">${String(i+1).padStart(2,'0')}</span><code><span class="action-name">${a.type}</span>${a.addr?` <span class="address">${a.addr}</span> <span class="dim">${a.hex}</span>`:''}</code><span class="dim">${state.mode==='verdict'&&state.verdict==='rejected'&&i===1?'× 拒绝':cursor>i?'✓':cursor===i?'← 当前':'↗'}</span></button>`).join('')}</div></section>`;
  }
  function output() {
    let c=`<div class="output-entry"><span class="time">00:00.000</span><p><span class="accent">[就绪]</span> ${esc(state.log)}</p></div><div class="output-entry"><span class="time">00:00.001</span><p class="dim">编译在本地完成。调试与正式提交使用两个独立实例。</p></div>`;
    if(state.compiled==='stale')c='<div class="output-callout warning"><strong>△ 积木已修改，已有产物过期</strong>重新编译后才能试运行、单步 payload 或提交。运行 N 步仍只作用于调试实例。</div>';
    if(state.compiled==='error')c=`<div class="output-callout error"><strong>! 编译错误 · block-write</strong>${state.scenario==='limit'?'循环展开 257 次，超过 LOOP_UNROLL_LIMIT = 256。表达式累计上限 4096 步，动作上限 4096。':'raw(hex) 需要成对的十六进制字符，收到 “4G”。'}<br>本次编译没有生成可用产物。<br><button data-locate="block-write">定位出错积木 ↗</button> <button data-action="fix-error">应用修正样例</button></div>`;
    if(state.waiting)c='<div class="output-callout warning"><strong>◌ 请求处理中</strong>正在等待调试实例返回；执行操作暂不可用，避免重复请求。'+(state.waitingPreview?'<br><button data-action="finish-wait">原型：展示返回结果</button>':'')+'</div>';
    if(state.debug.status==='satisfied'&&state.mode==='debug'&&!state.waiting)c='<div class="output-callout success"><strong>✓ 当前状态已满足成功条件</strong>这仍是调试实例。请提交完整 payload，从初始状态验证。你也可以继续调试。<br>'+button('submit','提交判题 ↗','compact')+'</div>';
    if(['failed','exited'].includes(state.debug.status)&&state.mode==='debug')c=`<div class="output-callout ${state.debug.status==='failed'?'error':'warning'}"><strong>${state.debug.status==='failed'?'! 执行异常 · 样例 error.message':'◇ 程序已结束，但未满足成功条件'}</strong>${state.debug.status==='failed'?'指令执行发生异常。error.note：回退观察公开地址 0x400001 附近的状态。':'执行操作已停止，可以撤销或重置后继续。'}<br>${button('back','后退一步','compact')} ${button('undo','撤销','compact')} ${button('reset','重置','compact')} ${state.debug.status==='failed'?'<button class="compact" data-target="0x400001">定位公开地址</button>':''}</div>`;
    if(state.mode==='verdict')c=state.verdict==='failed'?'<div class="output-callout error"><strong>! 异常 · 动作 3 / 帧 3</strong>error.message：指令执行发生异常。<br>error.note：检查公开指令地址 0x400002 附近的状态。<br><button data-target="0x400002">定位公开地址 ↗</button></div>':state.verdict==='rejected'?'<div class="output-callout error"><strong>× hidden_address · 动作 2 未生效</strong>error.message：不能写入隐藏区域。<br>error.note：key 只公开布局，请使用允许的动作。<br><button data-locate="block-address">定位被拒动作的积木 ↗</button></div>':`<div class="output-entry"><span class="time">回放 ${state.frame}/3</span><p><span class="${D.verdicts[state.verdict].tone}">[${D.verdicts[state.verdict].title}]</span> ${D.verdicts[state.verdict].detail}</p></div><p class="dim small">时间线按动作记录；一个 run 可能包含多条指令。原调试实例保持不变。</p>`;
    if(state.session==='loading')c='<div class="output-callout"><strong>◌ 正在创建会话</strong>公开题目与初始投影加载中。<br><button data-action="restart">原型：完成加载</button></div>';
    if(['expired','network'].includes(state.session))c='<div class="output-callout error"><strong>! 会话已失效</strong>保留当前画布与可见投影；重新开始创建新会话、清空调试历史。<br><button data-action="restart">重新开始</button></div>';
    if(state.session==='no-challenges')c='<div class="output-callout"><strong>◇ 公开题目列表为空</strong>未创建会话，调试与提交暂不可用。可刷新列表，或在下方切换其他原型状态。</div>';
    if(state.long)c+='<div class="output-callout error"><strong>! 长错误说明展示样例</strong>'+('公开 error.note：请核对参数类型与输入槽，定位后可重新编译。'.repeat(25))+'</div>';
    return `<section class="output-section" aria-label="输出区"><div class="section-head"><h2>输出</h2><span class="dim">状态与解释</span><span class="spacer"></span><span class="tag">公开样例</span></div><div class="output-body" id="output-body">${c}</div></section>`;
  }
  function replay() {
    if(state.mode!=='verdict')return '';
    const max=state.verdict==='rejected'?2:3;
    return `<section class="replay" aria-label="判题动作回放"><span class="hidden-color">◉ 判题回放</span><button data-action="frame-prev" class="compact" ${state.frame===0?'disabled':''} aria-label="上一动作帧">←</button><label for="replay-frame" class="sr-only">回放动作帧</label><input id="replay-frame" type="range" min="0" max="${max}" value="${state.frame}" aria-valuetext="帧 ${state.frame}，${D.frames[state.frame].label}"><button data-action="frame-next" class="compact" ${state.frame===max?'disabled':''} aria-label="下一动作帧">→</button><span class="frame-label">${state.frame} / ${max} · ${state.verdict==='rejected'&&state.frame===2?'动作 2 被拒，投影不变':D.frames[state.frame].label}</span><small class="dim">按动作记录，非逐指令录像</small><button data-action="return" class="compact">回到调试</button></section>`;
  }
  function footer() {
    return `<footer class="statusbar"><span>${state.mode==='debug'?'● 调试模式':'◉ 判题结果 / 只读'}</span><span>64 位 / LE</span><span>视图来源：${state.mode==='debug'?'调试公开投影':'录像公开帧'}</span><span class="spacer"></span><span>${state.mode==='debug'?`撤销 ${state.debug.undo} 次 · 指令回退 ${state.debug.stepBack} / 64`:'返回调试将保留原投影与执行位置'}</span></footer><aside class="demo-bar" aria-label="原型演示控制"><span class="demo-label">原型演示</span><label for="scenario" class="sr-only">选择演示状态</label><select id="scenario">${D.scenarios.map(([id,t])=>`<option value="${id}" ${state.scenario===id?'selected':''}>${t}</option>`).join('')}</select><span class="demo-note">公开合成数据 · 按钮切换预设反馈 · 不连接服务端</span><span class="spacer"></span><a href="design-spec.md">视觉规范 ↗</a><a href="handoff.md">接入说明 ↗</a><button data-action="reset-demo" class="compact">重置演示</button></aside>`;
  }
  function render() {
    const editorState=state;
    if(state.mode==='verdict')state={...state,compiled:'ready',compiledPadding:16,padding:16,empty:false,long:false,session:'active',selected:state.verdict==='rejected'?'block-address':null};
    const active=document.activeElement;
    const focused=active?.id;
    const focusAttrs=['data-action','data-menu','data-move','data-direction','data-mode','data-copy','data-category','data-locate','data-target','data-vma'].filter(k=>active?.hasAttribute(k));
    const focusSelector=focusAttrs.map(k=>'['+k+'='+JSON.stringify(active.getAttribute(k))+']').join('');
    const scrolls=['views-viewport','stack-scroll','disasm-scroll','block-stage','program-body','output-body'].map(id=>[id,document.getElementById(id)?.scrollTop||0]);
    app.innerHTML=header()+briefing()+sourceBar()+banner()+`<main id="workspace" class="workspace" tabindex="-1">${views()}<section class="payload-pane" aria-label="Payload 工作区"><section class="canvas-section"><div class="section-head"><span class="section-number">02</span><h2>构造 Payload</h2><span class="spacer"></span><span class="dim">${state.mode==='verdict'?'提交样例 · 只读':'从开始积木向下连接'}</span></div>${toolbar()}${canvas()}</section>${program()}${output()}</section></main>`+replay()+footer();
    for(const [id,top]of scrolls){const el=document.getElementById(id);if(el)el.scrollTop=top;}
    highlightProjectionOnce();
    state=editorState;
    if(focused)document.getElementById(focused)?.focus({preventScroll:true});
    else if(focusSelector)document.querySelector(focusSelector)?.focus({preventScroll:true});
  }
  let lastProjectionKey = '';
  function highlightProjectionOnce() {
    const key = `${state.mode}:${state.mode==='debug'?state.debug.frame:state.frame}:${state.mode==='verdict'?state.verdict:''}:${state.io}`;
    if(key===lastProjectionKey)document.querySelectorAll('.changed').forEach(el=>{el.style.animation='none';});
    lastProjectionKey=key;
  }
  function refreshReplay() {
    // 保留正在拖动的原生 range DOM，不中断指针捕获。
    const original=state;
    state={...state,compiled:'ready',compiledPadding:16,padding:16,empty:false,long:false,session:'active'};
    const scroll=$('#views-viewport').scrollTop;
    $('.left-pane').outerHTML=views();$('#views-viewport').scrollTop=scroll;
    $('.program-section').outerHTML=program();$('.output-section').outerHTML=output();$('.source-bar').outerHTML=sourceBar();
    const max=state.verdict==='rejected'?2:3;
    $('.frame-label').textContent=`${state.frame} / ${max} · ${state.verdict==='rejected'&&state.frame===2?'动作 2 被拒，投影不变':D.frames[state.frame].label}`;
    $('[data-action="frame-prev"]').disabled=state.frame===0;$('[data-action="frame-next"]').disabled=state.frame===max;
    $('#replay-frame').setAttribute('aria-valuetext',`帧 ${state.frame}，${D.frames[state.frame].label}`);
    highlightProjectionOnce();
    state=original;
  }
  function scrollView(kind) {
    if(!state.shown.includes(kind)){state.shown.push(kind);render();}
    const vp=$('#views-viewport'),slot=$(`[data-view-slot="${kind}"]`);
    if(slot)vp.scrollTo({top:slot.offsetTop-vp.firstElementChild.offsetTop,behavior:'smooth'});
  }
  function followAnchors() {
    requestAnimationFrame(()=>{for(const sel of ['.sp-row','.current-row']){const row=$(sel);if(row){const box=row.closest('.table-scroll');if(box)box.scrollTop=Math.max(0,row.offsetTop-box.offsetTop-30);}}});
  }
  function locate(id) {
    state.selected=id;state.category=null;render();const block=document.getElementById(id);
    if(block){block.scrollIntoView({block:'nearest',inline:'nearest'});block.focus({preventScroll:true});}tell(`已定位积木 ${id}。`);
  }
  function moveView(kind,delta) {
    const i=state.order.indexOf(kind),next=i+delta;
    if(next>=0&&next<state.order.length){[state.order[i],state.order[next]]=[state.order[next],state.order[i]];render();tell(`${names[kind]}视图已${delta<0?'上移':'下移'}`);}
  }
  function updateURL() {
    const url=new URL(location.href);url.searchParams.set('state',state.scenario);
    try{window.history.replaceState(null,'',url);}catch{/* file:// 浏览器限制不阻止交互 */}
  }
  const requestHistory=[];
  function chooseScenario(id,initial=false) {
    if(!D.scenarios.some(([key])=>key===id))id='default';
    state.requestId++;state.scenario=id;state.menu=null;state.category=null;state.waiting=false;state.waitingPreview=false;
    if(D.verdicts[id]){
      state.verdict=id;state.mode='verdict';state.frame=D.verdicts[id].frame;
      // 不覆盖调试对象。录像与提交积木使用独立展示快照，返回时恢复编辑状态。
    }else{
      requestHistory.length=0;state.mode='debug';state.session='active';state.compiled='ready';state.compiledPadding=16;state.padding=16;state.selected=null;
      state.long=false;state.empty=false;state.historyWindow=false;state.marked=null;state.offset=0;state.autoHint=false;
      state.debug={frame:0,cursor:0,status:'ready',undo:0,stepBack:0,failures:0};
      state.log='公开样例已就绪。先观察栈，再把你的思路连接到开始积木。';
      state.io=id==='io'&&!!(D.ioDeclaration.syscalls.length||D.ioDeclaration.fds.length);state.order=state.io?['memory','io','stack','disasm','registers']:['stack','disasm','registers','memory'];state.shown=[...state.order];
      if(id==='default'){state.padding=16;state.briefing=true;state.hintsOpen=false;}
      if(id==='io'){state.debug={frame:3,cursor:3,status:'ready',undo:2,stepBack:2,failures:0};state.memory='key';}
      if(id==='registers'){state.order=['registers','stack','disasm','memory'];state.debug={frame:3,cursor:3,status:'ready',undo:2,stepBack:2,failures:0};state.marked='pointer';}
      if(id==='uncompiled')state.compiled='none';
      if(id==='stale'){state.compiled='stale';state.padding=24;}
      if(id==='error'||id==='limit'){state.compiled='error';state.selected='block-write';}
      if(id==='waiting'){state.waiting=true;state.waitingPreview=true;}
      if(['complete','satisfied','debug-failed','exited','history'].includes(id))state.debug={frame:3,cursor:3,status:id==='satisfied'?'satisfied':id==='debug-failed'?'failed':id==='exited'?'exited':'ready',undo:2,stepBack:id==='history'?0:2,failures:id==='debug-failed'?1:0};
      if(id==='history')state.historyWindow=true;
      if(['expired','network','loading'].includes(id))state.session=id;
      if(id==='no-challenges'){state.session='no-challenges';state.empty=true;state.compiled='none';state.shown=[];}
      if(id==='empty'){state.empty=true;state.compiled='none';state.shown=[];}
      if(id==='hints'){state.debug.failures=2;state.hints=0;autoHints();state.hintsOpen=true;}
      if(id==='long'){state.long=true;state.briefing=true;}
    }
    render();$('#views-viewport').scrollTop=0;updateURL();
    if(!initial)tell(`原型演示：${D.scenarios.find(([key])=>key===id)[1]}。所有反馈均为预设样例。`);
  }
  function execute(a) {
    const reason=disabledReason(a);if(reason){tell(reason);return;}state.menu=null;
    if(a==='compile'){
      if(state.scenario==='error'||state.scenario==='limit'){state.compiled='error';state.selected='block-write';render();tell('编译失败，请定位积木或应用修正样例。');return;}
      state.compiled='ready';state.compiledPadding=state.padding;state.debug.cursor=0;state.log=state.empty?'空程序编译成功，动作序列为空。':'编译成功 · 加载预设动作序列，未发送执行请求。';render();tell(state.log);return;
    }
    if(a==='submit'){
      state.waiting=true;const request=++state.requestId;render();
      setTimeout(()=>{if(request!==state.requestId)return;state.waiting=false;state.verdict='incomplete';state.frame=3;state.mode='verdict';state.scenario='incomplete';render();updateURL();tell('样例判题结果：payload 跑完了，但没有达成目标。');},650);return;
    }
    if(a==='reset'){requestHistory.push({...state.debug});state.debug={frame:0,cursor:0,status:'ready',undo:state.debug.undo+1,stepBack:0,failures:state.debug.failures};state.log='reset · 已选择初始公开投影样例；程序位置回到开头。';render();tell(state.log);return;}
    if(a==='undo'){
      const prior=requestHistory.pop(),failures=state.debug.failures;state.debug=prior||{frame:0,cursor:0,status:'ready',undo:0,stepBack:0,failures};state.debug.failures=failures;state.log='undo · 撤销上一次请求，恢复请求前的样例。';render();tell(state.log);return;
    }
    if(a==='back'){
      state.debug={...state.debug,frame:state.debug.frame===3?4:2,stepBack:Math.max(0,state.debug.stepBack-1),status:'ready'};
      state.log='step_back · 回退一条指令（预设反馈），payload 动作位置不倒退。';render();followAnchors();tell(state.log);return;
    }
    requestHistory.push({...state.debug});state.waiting=true;const request=++state.requestId;render();
    setTimeout(()=>{
      if(request!==state.requestId)return;
      const total=actions().length,oldCursor=state.debug.cursor,next=a==='nstep'?oldCursor:a==='step'?Math.min(total,oldCursor+1):total;
      const projectedFrame=a==='nstep'||oldCursor>=total?3:Math.min(3,next);
      state.debug={...state.debug,frame:projectedFrame,cursor:next,undo:state.debug.undo+1,stepBack:projectedFrame===3?2:state.debug.stepBack};
      state.log=a==='nstep'?`step { count: ${state.n} } · 已选择运行反馈样例（非实际执行 ${state.n} 条指令）。`:a==='step'?(oldCursor<total?`下一个 payload 动作已完成：${next}/${total}。`:'payload 用完，提交 VM step（预设反馈）。'):oldCursor<total?'剩余动作已完成；下次试运行提交 run。':'payload 用完，提交 run（预设反馈）。';
      state.waiting=false;render();followAnchors();tell(state.log);
    },550);
  }
  function handleAction(a) {
    if(['compile','run','step','nstep','back','undo','reset','submit'].includes(a)){execute(a);return;}
    switch(a){
      case 'refresh-challenges':tell('公开题目列表仍为空（预设反馈）。可在原型演示中切换默认工作台。');return;
      case 'brief':state.briefing=!state.briefing;break;
      case 'hints':state.hintsOpen=!state.hintsOpen;break;
      case 'hint-next':state.hints=Math.min(3,state.hints+1);saveHints();tell(`已揭示 ${state.hints} / 3 条提示`);break;
      case 'return':state.mode='debug';tell('已返回调试，保留提交前的投影、执行位置与回退历史。');break;
      case 'view-list':state.menu=state.menu==='views'?null:'views';break;
      case 'views-prev':case 'views-next':{const vp=$('#views-viewport');vp.scrollBy({top:(a==='views-next'?1:-1)*vp.clientHeight/2,behavior:'smooth'});return;}
      case 'stdout':state.stdoutHex=!state.stdoutHex;break;
      case 'close-category':state.category=null;break;
      case 'pointer':state.marked='pointer';render();$('#stack-scroll').scrollTop=$('#stack-scroll').scrollHeight;return;
      case 'reset-demo':requestHistory.length=0;chooseScenario('default');return;
      case 'fix-error':state.scenario='stale';state.compiled='stale';state.selected='block-write';state.log='参数已修正，请重新编译。';updateURL();break;
      case 'finish-wait':state.waiting=false;state.waitingPreview=false;state.debug={...state.debug,frame:1,cursor:1,undo:1};state.log='动作成功 · 请求已返回，操作恢复可用。';break;
      case 'restart':state.requestId++;state.session='active';state.waiting=false;requestHistory.length=0;state.debug={frame:0,cursor:0,status:'ready',undo:0,stepBack:0,failures:0};state.log='已创建新会话（预设样例）。画布保留，调试历史已清空。';tell(state.log);break;
      case 'frame-prev':state.frame=Math.max(0,state.frame-1);break;
      case 'frame-next':state.frame=Math.min(state.verdict==='rejected'?2:3,state.frame+1);break;
      case 'jump':{
        const value=state.jump.trim().toLowerCase();if(!/^0x[0-9a-f]+$/.test(value)){tell('请输入十六进制地址，例如 0x7fffff18。');return;}
        const n=BigInt(value);
        if(n>=0x80000000n&&n<0x80001000n)state.marked='hidden';
        else if(n>=0x7fffff00n&&n<0x7fffff30n){state.offset=Number(n-0x7fffff00n)%8;state.marked=value;}
        else if(D.disasm.some(d=>d.addr===value)){state.marked=value;render();scrollView('disasm');return;}
        else if(D.vmas.some(v=>n>=BigInt(v.start)&&n<BigInt(v.end))){tell('地址已映射，此设计样例未提供该处字节；不会发起任意地址读取。');return;}
        else state.marked='unmapped';
        render();const target=$(`[data-address="${state.marked}"]`);if(target)target.scrollIntoView({block:'nearest'});else $('#stack-scroll').scrollTop=$('#stack-scroll').scrollHeight;tell(`已定位 ${value}，仅展示公开样例。`);return;
      }
      case 'search':{
        const raw=state.search.trim();let hex=raw.toLowerCase().replace(/\s/g,'');if(state.searchKind==='ASCII')hex=Array.from(new TextEncoder().encode(raw)).map(b=>b.toString(16).padStart(2,'0')).join('');
        if(!hex||!/^(?:[0-9a-f]{2})+$/.test(hex)){tell('请输入完整的 hex 字节对或 ASCII 文本。');return;}
        const row=stackRows().find(r=>r.bytes.join('').includes(hex));state.marked=row?.addr||null;render();if(row)$(`[data-address="${row.addr}"]`).scrollIntoView({block:'nearest'});tell(row?`已找到公开字节：${row.addr}`:'当前公开样例中未找到匹配字节。');return;
      }
    }
    render();if(a==='return')$('#mode-debug').focus({preventScroll:true});
    if(a.startsWith('frame-')){followAnchors();tell(`回放帧 ${state.frame}，所有视图已切换到同一公开快照。`);}
    if(a==='view-list')$('#view-menu-button').focus({preventScroll:true});
  }
  app.addEventListener('click',async e=>{
    const el=e.target.closest('button,[data-block]');if(!el||el.disabled||e.target.closest('select,input'))return;
    if(el.dataset.action){handleAction(el.dataset.action);return;}
    if(el.dataset.menu){state.menu=state.menu===el.dataset.menu?null:el.dataset.menu;render();return;}
    if(el.dataset.mode){state.mode=el.dataset.mode;render();tell(state.mode==='debug'?'调试模式，显示保留的调试投影。':'判题结果，显示独立录像帧。');return;}
    if(el.dataset.move){moveView(el.dataset.move,Number(el.dataset.direction));return;}
    if(el.dataset.locate){locate(el.dataset.locate);return;}
    if(el.dataset.block){state.selected=el.dataset.block;render();return;}
    if(el.dataset.category){state.category=state.category===el.dataset.category?null:el.dataset.category;render();return;}
    if(el.dataset.tool){tell(el.dataset.tool==='feed'?'feed 必须位于触发读取的 step / run 之前，否则程序先读到 EOF。':'原型展示积木外观与说明。真实拖拽拼接由 H 的 Blockly 工作区实现。');return;}
    if(el.dataset.vma){state.memory=el.dataset.vma;render();return;}
    if(el.dataset.target){state.marked=el.dataset.target;render();scrollView('disasm');$(`[data-view-slot="disasm"] [data-address="${state.marked}"]`)?.scrollIntoView({block:'nearest'});tell(`已定位公开指令 ${state.marked}`);return;}
    if(el.dataset.copy){try{await navigator.clipboard.writeText(el.dataset.copy);tell(`已复制 ${el.dataset.copy}`);}catch{tell(`无法访问剪贴板，请手动选择并复制：${el.dataset.copy}`);}return;}
  });
  app.addEventListener('input',e=>{
    if(e.target.id==='jump-address')state.jump=e.target.value;
    if(e.target.id==='stack-search')state.search=e.target.value;
    if(e.target.id==='replay-frame'){state.frame=Number(e.target.value);refreshReplay();followAnchors();$('#announcer').textContent=`判题录像帧 ${state.frame}，${D.frames[state.frame].label}`;}
  });
  app.addEventListener('change',e=>{
    const el=e.target;
    if(el.id==='scenario'){chooseScenario(el.value);return;}
    if(el.dataset.view){state.shown=el.checked?[...state.shown,el.dataset.view]:state.shown.filter(v=>v!==el.dataset.view);render();return;}
    if(el.id==='padding-count'){state.padding=Number(el.value);state.compiled='stale';render();tell('积木参数已修改：已过期，请重新编译。');}
    if(el.id==='stack-offset'){state.offset=Number(el.value);render();}
    if(el.id==='search-kind')state.searchKind=el.value;
    if(el.id==='function-select'){state.marked=el.value;render();$(`[data-view-slot="disasm"] [data-address="${state.marked}"]`)?.scrollIntoView({block:'nearest'});}
    if(el.id==='step-count'){state.n=Math.max(1,Math.min(10000,Math.trunc(Number(el.value)||1)));el.value=state.n;}
  });
  app.addEventListener('keydown',e=>{
    if(e.key==='Enter'&&e.target.id==='jump-address'){e.preventDefault();handleAction('jump');}
    if(e.key==='Enter'&&e.target.id==='stack-search'){e.preventDefault();handleAction('search');}
    if(e.target.matches('[data-block]')&&['Enter',' '].includes(e.key)){e.preventDefault();state.selected=e.target.dataset.block;render();}
  });
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){const menu=state.menu;state.menu=null;state.category=null;render();if(menu)document.getElementById(menu==='views'?'view-menu-button':'run-menu-button').focus();}
    if(e.ctrlKey&&['ArrowUp','ArrowDown'].includes(e.key)&&!e.target.matches('input,textarea,select,[contenteditable]')){e.preventDefault();handleAction(e.key==='ArrowUp'?'views-prev':'views-next');}
  });
  document.addEventListener('click',e=>{if(state.menu&&!e.target.closest('.menu-wrap')&&!e.target.closest('[data-action="view-list"]')){state.menu=null;render();}});
  let dragging=null;
  app.addEventListener('dragstart',e=>{dragging=e.target.closest('[data-drag]')?.dataset.drag;if(dragging){e.dataTransfer.setData('text/plain',dragging);e.dataTransfer.effectAllowed='move';}});
  app.addEventListener('dragover',e=>{if(e.target.closest('[data-drag]'))e.preventDefault();});
  app.addEventListener('drop',e=>{const target=e.target.closest('[data-drag]')?.dataset.drag;if(!dragging||!target)return;e.preventDefault();const from=state.order.indexOf(dragging),to=state.order.indexOf(target);state.order.splice(from,1);state.order.splice(to,0,dragging);dragging=null;render();tell('视图顺序已更新。');});
  chooseScenario(new URLSearchParams(location.search).get('state')||'default',true);
})();
