// Profitability view browser JS. Same template-literal rules as the other *-js
// modules: browser JS inside a TS template literal - no backticks or dollar-
// brace, '+' concatenation, esc() every dynamic value, double-escape backslashes.
// Reuses the shared helpers el(), esc(), setMsg(), api(), prtArm().
export const profitJs = `
// --- Profitability: the observe-first profit audit window ---
var pfState={rows:[],config:null};
function pfChip(v){
  if(v==='reject') return '<span class="pf-chip pf-reject">reject</span>';
  if(v==='review') return '<span class="pf-chip pf-review">review</span>';
  return '<span class="pf-chip pf-pass">pass</span>';
}
function pfMoney(n){ return (n===null||n===undefined)?'-':('GBP '+Number(n).toFixed(2)); }
function pfRowHtml(r){
  var neg=(r.netGbp!==null&&r.netGbp<0);
  var name=r.handle?r.handle:r.cjPid;
  var h='<div class="pf-row">'
    +'<div class="pf-head"><span class="pf-name">'+esc(name)+'</span>'+pfChip(r.verdict);
  if(r.linkState==='archived') h+='<span class="pf-chip pf-arch">archived</span>';
  h+='<span class="pf-net '+(neg?'neg':'pos')+'">net '+esc(pfMoney(r.netGbp))
    +(r.netPct!==null?(' ('+Math.round(r.netPct*100)+'%)'):'')+'</span></div>';
  var meta='<span><strong>Our price</strong> '+esc(pfMoney(r.ourRetailGbp))+'</span>';
  if(r.competitorGbp!==null&&r.competitorGbp>0){
    meta+=' &middot; <span><strong>UK street</strong> ~'+esc(pfMoney(r.competitorGbp))
      +(r.competitorConfidence?(' ('+esc(r.competitorConfidence)+')'):'')+'</span>';
    if(r.sources&&r.sources.length) meta+=' &middot; '+esc(r.sources.join(', '));
  }
  h+='<div class="pf-meta">'+meta+'</div>';
  if(r.reason) h+='<div class="pf-meta">'+esc(r.reason)+'</div>';
  if(r.verdict!=='pass'&&r.linkState&&r.linkState!=='archived'&&r.productId){
    // Delegated click (see the IIFE below): the pid rides a data- attribute,
    // never an inline JS string, so nothing dynamic is interpolated into code.
    h+='<div class="pf-actions"><button type="button" class="ghost" data-pf-pid="'+esc(r.cjPid)+'">Archive (confirm)</button></div>';
  }
  return h+'</div>';
}
function pfRender(){
  var c=pfState.config||{};
  var en=el('pf-enabled'); if(en) en.checked=!!c.enabled;
  var hb=el('pf-hardblock'); if(hb){ hb.checked=!!c.hardBlock; hb.disabled=!c.enabled; }
  var th=el('pf-thresholds');
  if(th) th.innerHTML='Thresholds (tune in tenant_config.profit): ad share <strong>'
    +Math.round((c.adShareOfRevenue||0)*100)+'%</strong> of revenue, net floor <strong>'
    +esc(pfMoney(c.minNetAfterAdsGbp))+' / '+Math.round((c.minNetMarginPct||0)*100)
    +'%</strong>, competitor tolerance <strong>'+Math.round((c.competitionTolerancePct||0)*100)+'%</strong>.';
  var box=el('pf-list');
  if(box){
    if(!pfState.rows.length){ box.innerHTML='<p class="muted">No verdicts yet. Turn on Observe and run the audit.</p>'; }
    else{ var s=''; for(var i=0;i<pfState.rows.length;i++) s+=pfRowHtml(pfState.rows[i]); box.innerHTML=s; }
  }
}
function pfSummary(sm){
  var el2=el('pf-summary'); if(!el2||!sm) return;
  if(!sm.total){ el2.textContent='Nothing audited yet.'; return; }
  el2.textContent=sm.reject+' reject, '+sm.review+' review of '+sm.total+' audited'
    +(sm.lastCheckedAt?(' - last '+new Date(sm.lastCheckedAt).toLocaleString()):'');
}
async function pfLoad(){
  try{
    var r=await api('/profit',{});
    if(!r.ok){ setMsg('pf-msg','Failed to load.','no'); return; }
    pfState.config=r.config; pfState.rows=r.rows; pfRender(); pfSummary(r.summary);
  }catch(e){ setMsg('pf-msg','Could not load the audit.','no'); }
}
async function pfSetFlag(flag,on){
  var body={}; body[flag]=!!on;
  setMsg('pf-msg','Saving…','muted');
  try{
    var r=await api('/profit/config',body);
    if(!r.ok){ setMsg('pf-msg','Failed: '+(r.error||'unknown'),'no'); return; }
    setMsg('pf-msg', (flag==='enabled'?(on?'Observe on.':'Observe off (dormant).'):(on?'Enforce on.':'Enforce off.')),'ok');
    pfLoad();
  }catch(e){ setMsg('pf-msg','Could not save.','no'); }
}
async function pfRunAudit(btn){
  if(!pfState.config||!pfState.config.enabled){ setMsg('pf-msg','Turn on Observe first.','no'); return; }
  if(btn) btn.disabled=true;
  var offset=0, guard=0;
  try{
    while(guard++<200){
      var r=await api('/profit/run',{offset:offset});
      if(!r.ok){ setMsg('pf-msg','Audit failed: '+(r.error||'unknown'),'no'); break; }
      if(btn) btn.textContent='Auditing '+Math.min(r.offset+r.scanned,r.total)+'/'+r.total+'…';
      if(r.next===null||r.next===undefined){ setMsg('pf-msg','Audit complete.','ok'); break; }
      offset=r.next;
    }
  }catch(e){ setMsg('pf-msg','Audit stopped.','no'); }
  if(btn){ btn.disabled=false; btn.textContent='Run audit now'; }
  pfLoad();
}
async function pfArchive(btn,pid){
  if(!prtArm(btn,'Click again to archive')) return;
  try{
    var r=await api('/profit/archive',{cjPid:pid});
    if(!r.ok){ setMsg('pf-msg','Archive failed: '+(r.error||'unknown'),'no'); return; }
    setMsg('pf-msg','Archived.','ok');
    pfLoad();
  }catch(e){ setMsg('pf-msg','Could not archive.','no'); }
}
(function(){
  var list=el('pf-list');
  if(list) list.addEventListener('click',function(e){
    var btn=e.target&&e.target.closest?e.target.closest('[data-pf-pid]'):null;
    if(!btn) return;
    pfArchive(btn,btn.getAttribute('data-pf-pid'));
  });
})();
`;
