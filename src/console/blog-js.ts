// Content view browser JS. Same template-literal rules as the other *-js
// modules: browser JS inside a TS template literal - no backticks or
// dollar-brace, '+' concatenation, esc() every dynamic value.
export const blogJs = `
// --- Content: blog agents author DRAFT posts (the system authors; a human publishes) ---
function blgItemHtml(p){
  var flags=[]; try{ flags=JSON.parse(p.claim_flags_json||'[]'); }catch(e){}
  var related=[]; try{ related=JSON.parse(p.related_handles_json||'[]'); }catch(e){}
  var h='<div class="blg-item">'
    +'<div class="blg-item-head"><span class="blg-item-title">'+esc(p.title)+'</span>'
    +'<span class="badge '+(p.status==='published'?'ok':'muted')+'">'+esc(p.status)+'</span></div>';
  if(p.collection_handle) h+='<div class="blg-meta">Funnels to /collections/'+esc(p.collection_handle)+'</div>';
  if(flags.length){
    var concerns={}; for(var j=0;j<flags.length;j++){ concerns[flags[j].concern]=1; }
    h+='<div class="blg-flags">'+flags.length+' line(s) to verify before publishing ('+esc(Object.keys(concerns).join(', '))+').</div>';
  }
  if(related.length){
    h+='<div class="blg-meta">Shop this guide: '+related.length+' product(s)'+(p.hero_source_handle?', hero from '+esc(p.hero_source_handle):'')+'.</div>';
  }
  if(p.shopify_article_id && p.status!=='published'){
    h+='<div class="blg-actions"><button type="button" class="btn-sm" onclick="blogEnrich(\\''+esc(p.shopify_article_id)+'\\')">'
      +(related.length?'Refresh image + shop block':'Add image + shop block')+'</button></div>';
  }
  h+='<div class="blg-meta">Review and publish in Shopify admin: Online Store &gt; Blog posts. You can swap the hero image there before publishing.</div>';
  return h+'</div>';
}
async function loadContent(){
  var box=el('blg-list'); if(!box) return;
  try{
    var r=await api('/blog/list',{});
    if(!r.ok){ box.innerHTML='<p class="muted">Could not load drafts.</p>'; return; }
    if(!r.posts||!r.posts.length){ box.innerHTML='<p class="muted">No posts yet. Draft your first one above.</p>'; return; }
    var h=''; for(var i=0;i<r.posts.length;i++) h+=blgItemHtml(r.posts[i]);
    box.innerHTML=h;
  }catch(e){ box.innerHTML='<p class="muted">Could not load drafts.</p>'; }
}
async function blogGenerate(){
  var btn=el('blg-gen-btn');
  var topic=((el('blg-topic')&&el('blg-topic').value)||'').trim();
  if(btn) btn.disabled=true;
  setMsg('blg-msg','Researching an angle and writing the post. This can take up to a minute.','muted');
  try{
    var r=await api('/blog/generate',{topicHint:topic});
    if(!r.ok){ setMsg('blg-msg','Could not create a post: '+esc(r.error||'unknown error'),'no'); }
    else{
      var extra=(r.claimFlags&&r.claimFlags.length)?(' '+r.claimFlags.length+' line(s) were flagged to verify before you publish.'):'';
      setMsg('blg-msg','Draft created: "'+esc(r.title)+'". Review and publish it in Shopify admin (Online Store, Blog posts).'+extra,'ok');
      if(el('blg-topic')) el('blg-topic').value='';
      loadContent();
    }
  }catch(e){ setMsg('blg-msg','Could not create a post: '+errText(e),'no'); }
  if(btn) btn.disabled=false;
}
async function blogEnrich(articleId){
  setMsg('blg-msg','Adding the shop block and a hero image. This reads the post and picks products it links.','muted');
  try{
    var r=await api('/blog/enrich',{articleId:articleId});
    if(!r.ok){ setMsg('blg-msg','Could not enrich the post: '+esc(r.error||'unknown error'),'no'); return; }
    var n=(r.relatedHandles&&r.relatedHandles.length)||0;
    var img;
    if(r.imageSet){
      img=' Hero image added'+(r.heroSourceHandle?(' from '+esc(r.heroSourceHandle)):'')+'.';
      if(!r.heroIsHighRes){ img+=' That source is under 1200px, so the social card will not be full size - upload a larger hero in admin for a crisp 1200x1200 preview.'; }
    }else{
      img=r.hadImage?' Your existing hero image was kept.':' No product image was available for a hero.';
    }
    setMsg('blg-msg','Shop block set: '+n+' product(s).'+img+' Review and publish in Shopify admin (you can swap the hero there).','ok');
    loadContent();
  }catch(e){ setMsg('blg-msg','Could not enrich the post: '+errText(e),'no'); }
}
`;
