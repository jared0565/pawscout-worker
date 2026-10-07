// Traffic view browser JS. Same template-literal rules as the other *-js
// modules: browser JS inside a TS template literal - no backticks or
// dollar-brace, '+' concatenation, esc() every dynamic value, double-escape
// backslashes. Composed after partnersJs (reuses prtArm for the delete).
export const trafficJs = `
// --- Traffic: acquisition strategy board ---
var trfState={channels:[]};
function trfChip(s){
  if(s==='active') return '<span class="trf-chip trf-active">active</span>';
  if(s==='testing') return '<span class="trf-chip trf-testing">testing</span>';
  if(s==='paused') return '<span class="trf-chip trf-paused">paused</span>';
  return '<span class="trf-chip trf-idea">idea</span>';
}
function trfRowHtml(ch){
  var h='<div class="trf-row" data-trf-id="'+esc(ch.id)+'">'
    +'<div class="trf-head"><span class="trf-name">'+esc(ch.name)+'</span>'+trfChip(ch.status)
    +'<span class="trf-prio">priority '+esc(ch.priority)+'</span></div>';
  if(ch.nextAction) h+='<div class="trf-next"><strong>Next:</strong> '+esc(ch.nextAction)+'</div>';
  return h+'</div>';
}
// --- Traffic activity (2026-10-07): daily charts above the board ---
// Inline SVG, no library: one column per day, a <title> per column for the
// hover text, the axis top rounded so a 0 to 5 people week stays readable and a
// 242-visit crawler day gets a round ceiling of its own (separate chart).
function trfNiceMax(v){
  if(!(v>0)) return 1;
  if(v<=10) return Math.ceil(v);
  var mag=Math.pow(10,Math.floor(Math.log(v)/Math.LN10));
  var steps=[1,1.5,2,3,4,5,6,8,10];
  for(var i=0;i<steps.length;i++){ if(steps[i]*mag>=v) return Math.round(steps[i]*mag); }
  return Math.round(10*mag);
}
var TRF_DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
var TRF_MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function trfDate(day){ var p=String(day).split('-'); return new Date(Date.UTC(+p[0],+p[1]-1,+p[2])); }
function trfDayLong(day){ var d=trfDate(day); return TRF_DOW[d.getUTCDay()]+' '+d.getUTCDate()+' '+TRF_MON[d.getUTCMonth()]; }
function trfDayShort(day){ var d=trfDate(day); return d.getUTCDate()+' '+TRF_MON[d.getUTCMonth()]; }
function trfNum(v){ return (typeof v==='number'&&isFinite(v))?v:0; }
function trfDayTitle(d,layers,partial,withActions){
  var parts=[];
  for(var i=0;i<layers.length;i++) parts.push(layers[i].label+' '+trfNum(d[layers[i].key]));
  var extra=[];
  if(withActions){
    if(trfNum(d.cartAdds)>0) extra.push(trfNum(d.cartAdds)+' added to cart');
    if(trfNum(d.reachedCheckout)>0) extra.push(trfNum(d.reachedCheckout)+' reached checkout');
    if(trfNum(d.completedCheckout)>0) extra.push(trfNum(d.completedCheckout)+' completed checkout');
  }
  return trfDayLong(d.day)+(partial?' (today, so far)':'')+': '+parts.join(', ')+(extra.length?'; '+extra.join(', '):'');
}
function trfBarsSvg(series,layers,opts){
  // Drawn at the container's own pixel width (floor 320) so the axis text is
  // its real size in a wide card instead of scaling up with the viewBox.
  var W=opts.width?Math.max(320,Math.round(opts.width)):700,H=opts.height||160,padL=30,padR=6,padT=12,padB=20;
  var plotH=H-padT-padB,plotW=W-padL-padR,n=series.length||1;
  var max=0,i,j;
  for(i=0;i<series.length;i++){ var tot=0; for(j=0;j<layers.length;j++) tot+=trfNum(series[i][layers[j].key]); if(tot>max) max=tot; }
  var top=trfNiceMax(max),slot=plotW/n,bw=Math.max(1,Math.min(28,slot*0.72));
  var y=function(v){ return padT+plotH-(v/top)*plotH; };
  var s='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+esc(opts.label||'Daily chart')+'">';
  var ticks=[0,top]; if(top>=2&&top%2===0) ticks.splice(1,0,top/2);
  for(var k=0;k<ticks.length;k++){
    var ty=y(ticks[k]).toFixed(1);
    s+='<line class="trf-grid" x1="'+padL+'" x2="'+(W-padR)+'" y1="'+ty+'" y2="'+ty+'"/>';
    s+='<text x="'+(padL-6)+'" y="'+ty+'" text-anchor="end" dominant-baseline="middle">'+esc(String(ticks[k]))+'</text>';
  }
  var step=n<=7?1:(n<=31?7:15);
  for(i=0;i<series.length;i++){
    var d=series[i],x=padL+i*slot,cx=x+slot/2,partial=!!opts.partialLast&&i===series.length-1;
    s+='<g class="trf-col'+(partial?' trf-today':'')+'"><title>'+esc(trfDayTitle(d,layers,partial,!!opts.marks))+'</title>';
    s+='<rect class="trf-hit" x="'+x.toFixed(1)+'" y="'+padT+'" width="'+slot.toFixed(1)+'" height="'+plotH+'" fill="transparent"/>';
    var acc=0;
    for(j=0;j<layers.length;j++){
      var v=trfNum(d[layers[j].key]); if(v<=0) continue;
      var y1=y(acc+v),y0=y(acc);
      s+='<rect class="trf-seg" x="'+(cx-bw/2).toFixed(1)+'" y="'+y1.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(1,y0-y1).toFixed(1)+'" fill="'+esc(layers[j].color)+'"/>';
      acc+=v;
    }
    if(opts.marks&&trfNum(d[opts.marks])>0) s+='<circle class="trf-mark" cx="'+cx.toFixed(1)+'" cy="'+(y(acc)-6).toFixed(1)+'" r="3.5"/>';
    s+='</g>';
    if((series.length-1-i)%step===0){
      var lbl=n<=7?trfDayLong(d.day).split(' ').slice(0,2).join(' '):trfDayShort(d.day);
      s+='<text x="'+cx.toFixed(1)+'" y="'+(H-5)+'" text-anchor="middle">'+esc(lbl)+'</text>';
    }
  }
  return s+'</svg>';
}
function trfRankHtml(items,empty){
  if(!items||!items.length) return '<p class="muted" style="margin:4px 0">'+esc(empty)+'</p>';
  var max=1,i;
  for(i=0;i<items.length;i++) if(items[i].people>max) max=items[i].people;
  var h='';
  for(i=0;i<items.length;i++){
    var it=items[i],w=Math.max(2,Math.round(100*it.people/max));
    h+='<div class="trf-rank-row"><span class="trf-rank-label" title="'+esc(it.label)+'">'+esc(it.label)+'</span>'
      +'<span class="trf-rank-n">'+esc(String(it.people))+'</span>'
      +'<div class="trf-rank-bar"><b style="width:'+w+'%"></b></div></div>';
  }
  return h;
}
// --- end traffic charts ---
var TRF_SOURCES={direct:'Direct (typed, bookmarked or an app)',search:'Search engines',social:'Social',email:'Email',unknown:'Unknown'};
function trfPct(v){ return (v===null||v===undefined)?'n/a':(String(v)+'%'); }
function trfKpi(num,label,sub){
  return '<div class="trf-q-kpi"><div class="num">'+esc(String(num))+'</div><div class="sub">'+esc(label)+(sub?'<br>'+esc(sub):'')+'</div></div>';
}
function trfActivityHtml(r,width){
  var a=r.activity,t=a.totals,h='',i;
  var at=new Date(r.at);
  h+='<p class="trf-caption">'+esc(trfDayShort(a.from))+' to '+esc(trfDayShort(a.to))+', today counted so far. Updated '+esc(at.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))+'.</p>';
  if(a.truncated) h+='<p class="msg no">Shopify returned the most rows it allows for this range, so these totals may be short. Try a shorter range.</p>';
  h+='<div class="trf-q-grid">'
    +trfKpi(t.people,'People',t.engaged+' engaged, '+t.singlePage+' single-page')
    +trfKpi(t.cartAdds,'Added to cart','by people')
    +trfKpi(t.reachedCheckout,'Reached checkout','by people')
    +trfKpi(t.completedCheckout,'Completed checkout','by people')
    +trfKpi(t.automated,'Automated',trfPct(t.automatedShare)+' of all visits')
    +'</div>';
  h+='<div class="trf-q-title">People per day</div><div class="trf-chart">'
    +trfBarsSvg(a.series,[{key:'engaged',color:'#8fe0a6',label:'Engaged'},{key:'singlePage',color:'#4f7a5c',label:'Single-page'}],{height:180,width:width,partialLast:true,marks:'cartAdds',label:'People per day'})
    +'</div><div class="trf-legend"><span><i style="background:#8fe0a6"></i>Engaged (more than one page)</span><span><i style="background:#4f7a5c"></i>Single-page</span><span><i class="dot" style="background:#f0c674"></i>Someone added to cart</span><span>Hover a day for its numbers</span></div>';
  h+='<div class="trf-q-title">Automated visits per day</div><div class="trf-chart">'
    +trfBarsSvg(a.series,[{key:'automated',color:'#6a6e73',label:'Automated'}],{height:110,width:width,partialLast:true,label:'Automated visits per day'})
    +'</div>';
  var bots='';
  for(i=0;i<(a.topAutomated||[]).length;i++) bots+=(bots?', ':'')+esc(a.topAutomated[i].browser)+' '+esc(String(a.topAutomated[i].sessions));
  if(bots) h+='<p class="muted" style="margin:4px 0 0;font-size:12px">Most automated: '+bots+'</p>';
  var refs=[];
  for(i=0;i<(a.referrers||[]).length;i++) refs.push({label:TRF_SOURCES[a.referrers[i].label]||a.referrers[i].label,people:a.referrers[i].people});
  h+='<div class="trf-two"><div><div class="trf-q-title">Where people came from</div>'+trfRankHtml(refs,'No people in this range.')+'</div>'
    +'<div><div class="trf-q-title">Where people landed</div>'+trfRankHtml(a.landing,'No people in this range.')+'</div></div>';
  h+='<p class="muted" style="margin:14px 0 0;font-size:13px">Bounce rate, people only: <strong>'+esc(trfPct(t.peopleBounceRate))+'</strong>. As Shopify shows it, all visits included: '+esc(trfPct(t.rawBounceRate))+'.</p>';
  return h;
}
var trfAct={days:30,loadedAt:0,seq:0};
async function trfActivityLoad(days){
  var box=el('trf-activity'); if(!box) return;
  trfAct.days=days;
  var seq=++trfAct.seq;
  var btns=document.querySelectorAll('[data-trf-days]');
  for(var i=0;i<btns.length;i++){
    if(btns[i].getAttribute('data-trf-days')===String(days)) btns[i].classList.add('active'); else btns[i].classList.remove('active');
  }
  box.innerHTML='<p class="muted">Loading the last '+esc(String(days))+' days…</p>';
  try{
    var r=await api('/traffic/activity',{days:days});
    if(seq!==trfAct.seq) return; // a newer range was asked for meanwhile
    if(!r.ok){
      if(r.reason==='scope_missing'){
        box.innerHTML='<p class="msg muted">Needs the <code>'+esc(r.scope||'read_reports')+'</code> access scope. Add it to the app in the Shopify Dev Dashboard, then reopen PawScout in the admin and accept the new permission; this card fills in on the next load.</p>';
      }else if(r.reason==='not_connected'){
        box.innerHTML='<p class="msg muted">Shopify is not connected for this shop yet.</p>';
      }else{
        box.innerHTML='<p class="msg no">Could not read the session table: '+esc(r.error||r.reason||'unknown error')+'</p>';
      }
      return;
    }
    trfAct.loadedAt=Date.now();
    box.innerHTML=trfActivityHtml(r,box.clientWidth);
  }catch(e){ if(seq===trfAct.seq) box.innerHTML='<p class="msg no">Could not read the session table: '+esc(errText(e))+'</p>'; }
}
// Three ShopifyQL reads per load, so only when the Traffic view is open (the
// console boots every view), and again after five minutes on a return visit.
// ROUTES is assigned by the router at the end of this script, hence the tick.
function trfMaybeLoadActivity(){
  if(typeof ROUTES==='undefined') return;
  if(currentRoute()==='traffic'&&Date.now()-trfAct.loadedAt>300000) trfActivityLoad(trfAct.days);
}
window.addEventListener('hashchange',trfMaybeLoadActivity);
setTimeout(trfMaybeLoadActivity,0);
(function(){
  var card=el('trf-activity-card');
  if(card) card.addEventListener('click',function(e){
    var b=e.target&&e.target.closest?e.target.closest('[data-trf-days]'):null;
    if(!b) return;
    trfActivityLoad(parseInt(b.getAttribute('data-trf-days'),10));
  });
})();
async function loadTraffic(){
  var box=el('trf-list'); if(!box) return;
  try{
    var r=await api('/traffic',{});
    if(!r.ok){ setMsg('trf-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    trfState.channels=r.channels;
    var h='';
    for(var i=0;i<r.channels.length;i++) h+=trfRowHtml(r.channels[i]);
    box.innerHTML=h||'<p class="muted">No channels yet. Add the first one below.</p>';
  }catch(e){ setMsg('trf-msg','Could not load the board.','no'); }
}
function trfFill(ch){
  el('trf-id').value=ch.id||'';
  el('trf-name').value=ch.name||'';
  el('trf-status').value=ch.status||'idea';
  el('trf-priority').value=String(ch.priority||3);
  el('trf-rationale').value=ch.rationale||'';
  el('trf-next').value=ch.nextAction||'';
  el('trf-notes').value=ch.notes||'';
  var del=el('trf-delete-btn'); if(del) del.hidden=!ch.id;
  var t=el('trf-editor-title'); if(t) t.textContent=ch.id?('Edit: '+ch.name):'New channel';
  var card=el('trf-editor-card'); if(card){ card.hidden=false; card.scrollIntoView({block:'nearest'}); }
  setMsg('trf-editor-msg','','muted');
}
function trfNew(){ trfFill({}); }
function trfCloseEditor(){ var card=el('trf-editor-card'); if(card) card.hidden=true; }
async function trfSave(){
  var body={
    name:el('trf-name').value.trim(),
    status:el('trf-status').value,
    priority:parseInt(el('trf-priority').value,10),
    rationale:el('trf-rationale').value.trim(),
    nextAction:el('trf-next').value.trim(),
    notes:el('trf-notes').value.trim()
  };
  var id=el('trf-id').value; if(id) body.id=id;
  if(!body.name){ setMsg('trf-editor-msg','Give the channel a name.','no'); return; }
  setMsg('trf-editor-msg','Saving…','muted');
  try{
    var r=await api('/traffic/save',body);
    if(!r.ok){ setMsg('trf-editor-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('trf-editor-msg','Saved.','ok');
    trfCloseEditor();
    loadTraffic();
  }catch(e){ setMsg('trf-editor-msg','Could not save.','no'); }
}
async function trfDelete(btn){
  var id=el('trf-id').value; if(!id) return;
  if(!prtArm(btn,'Click again to delete')) return;
  try{
    var r=await api('/traffic/delete',{id:id});
    if(!r.ok){ setMsg('trf-editor-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    trfCloseEditor();
    loadTraffic();
  }catch(e){ setMsg('trf-editor-msg','Could not delete.','no'); }
}
(function(){
  var list=el('trf-list');
  if(list) list.addEventListener('click',function(e){
    var row=e.target&&e.target.closest?e.target.closest('[data-trf-id]'):null;
    if(!row) return;
    var id=row.getAttribute('data-trf-id');
    for(var i=0;i<trfState.channels.length;i++){
      if(trfState.channels[i].id===id){ trfFill(trfState.channels[i]); return; }
    }
  });
})();
`;
