// Answer-library page browser JS (moved out of inbox-js.ts, 2026-07-13, when
// the library became its own page). Concatenated into page.ts's single inline
// <script>, so the globals el/esc/api/setMsg are in scope. Console conventions
// (see console-page-template-literal-gotcha): string concatenation only (no
// backticks / ${} inside), esc() every dynamic value, data-* + a delegated
// click handler for row actions, and NO backslash escapes in the emitted JS.
export const answersJs = `
var ansRows=[];
function ansFmtDate(iso){ try{ return new Date(iso).toLocaleDateString(); }catch(e){ return ''; } }
function ansRender(){
  var box=el('ans-list'); if(!box) return;
  if(!ansRows.length){ box.innerHTML='<p class="ansp-empty">Nothing remembered yet - pairs appear as you approve replies (history imports automatically on the first sweep).</p>'; return; }
  var q=(el('ans-search')&&el('ans-search').value||'').trim().toLowerCase();
  var rows=ansRows;
  if(q){ rows=ansRows.filter(function(a){ return (String(a.question||'')+' '+String(a.answer||'')+' '+String(a.category||'')).toLowerCase().indexOf(q)>=0; }); }
  if(!rows.length){ box.innerHTML='<p class="ansp-empty">No remembered answers match your search.</p>'; return; }
  var s='';
  for(var i=0;i<rows.length;i++){
    var a=rows[i];
    var meta='Used '+esc(String(a.usedCount))+'x';
    if(a.lastUsedAt) meta+=' \\u00b7 last '+esc(ansFmtDate(a.lastUsedAt));
    s+='<div class="ansp-card'+(a.disabled?' off':'')+'">'
      +'<div class="ansp-top">'
        +'<span class="ansp-cat">'+esc(a.category)+'</span>'
        +'<span class="ansp-meta">'+meta+'</span>'
        +'<span class="ansp-spacer"></span>'
        +'<button type="button" class="ghost" data-ans-toggle="'+esc(a.qhash)+'" data-ans-off="'+(a.disabled?'0':'1')+'">'+(a.disabled?'Enable':'Disable')+'</button>'
      +'</div>'
      +'<p class="ansp-q"><span class="ansp-label">Question</span>'+esc(a.question)+'</p>'
      +'<p class="ansp-a"><span class="ansp-label">Approved answer</span>'+esc(a.answer)+'</p>'
      +'</div>';
  }
  box.innerHTML=s;
}
function ansFilter(){ ansRender(); }
async function ansLoad(){
  var box=el('ans-list'); if(!box) return false;
  try{
    var r=await api('/inbox/answers',{});
    if(!r.ok){ setMsg('ans-msg','Failed to load.','no'); return false; }
    ansRows=r.rows||[];
    var cnt=el('ans-count');
    if(cnt) cnt.textContent=r.total+' remembered answer'+(r.total===1?'':'s')+(r.disabled?(' ('+r.disabled+' disabled)'):'');
    ansRender();
    return true;
  }catch(e){ setMsg('ans-msg','Could not load.','no'); return false; }
}
async function ansToggle(btn,qhash,off){
  btn.disabled=true;
  try{
    var r=await api('/inbox/answers/toggle',{qhash:qhash,disabled:off});
    if(!r.ok){ setMsg('ans-msg','Failed: '+(r.error||'unknown'),'no'); btn.disabled=false; return; }
    setMsg('ans-msg',off?'Disabled - this answer will not be recalled.':'Enabled again.','ok');
    ansLoad();
  }catch(e){ setMsg('ans-msg','Could not save.','no'); btn.disabled=false; }
}
(function(){
  var box=el('ans-list');
  if(box) box.addEventListener('click',function(e){
    var b=e.target&&e.target.closest?e.target.closest('[data-ans-toggle]'):null;
    if(!b) return;
    ansToggle(b,b.getAttribute('data-ans-toggle'),b.getAttribute('data-ans-off')==='1');
  });
  // Lazy-load: fetch when the Answers page is first opened (nav or deep-link),
  // not on every console boot. Route parse mirrors shell.ts currentRoute().
  // 'loaded' latches only on a SUCCESSFUL load, so a transient first-load
  // failure retries on the next visit (not just via the Refresh button).
  var loaded=false;
  function ansRoute(){ var h=location.hash||''; if(h.indexOf('#/')===0) h=h.slice(2); else if(h.indexOf('#')===0) h=h.slice(1); return h; }
  function ansMaybe(){ if(ansRoute()==='answers'&&!loaded){ ansLoad().then(function(ok){ loaded=!!ok; }); } }
  window.addEventListener('hashchange',ansMaybe);
  ansMaybe();
})();
`;
