<template>
  <section class="seal-stage">
    <header><div><small>Independent Seal Workspace</small><h1>历史真实印章匹配</h1></div><span>{{ engine }}</span></header>
    <p class="notice">仅比较当前印章与人工确认的历史印章图像，不证明物理印章、签署行为或合同真实性。文件仅在本机处理，不调用 Qwen、DeepSeek 或 OCR。</p>
    <div v-if="error" role="alert" class="error">{{ error }}</div>
    <nav class="tabs"><button :class="{primary:mode==='query'}" @click="switchMode('query')">待测印章匹配</button><button :class="{primary:mode==='reference'}" @click="switchMode('reference')">参考样本库</button></nav>
    <section v-if="mode==='reference'" class="card">
      <h2>1. 管理实际印章身份</h2><p>同一单位的不同印章应分别建组，不要仅凭文件名确认身份。建议每个身份收集 5–20 个不同合同的样本。</p>
      <form class="form" @submit.prevent="createGroup"><label>身份编号（label）<input v-model="groupForm.label" required maxlength="128" /></label><label>印章名称<input v-model="groupForm.sealName" required maxlength="255" /></label><label>单位名称<input v-model="groupForm.companyName" required maxlength="255" /></label><button :disabled="saving">建立身份</button></form>
      <label class="select">当前身份<select v-model="groupId" @change="loadSamples"><option value="">请选择身份</option><option v-for="g in groups" :key="g.id" :value="String(g.id)">{{ g.label }} · {{ g.seal_name }}（{{ g.sample_count }} 样本 / {{ g.independent_sources }} 来源）</option></select></label>
      <div class="samples"><article v-for="s in samples" :key="s.id"><img :src="`/api/seal/samples/${s.id}/image`" alt="参考印章" loading="lazy" /><div><strong>#{{ s.id }} · {{ s.source_file_name }}</strong><p>第 {{ s.page_number }} 页 · 质量 {{ s.quality_score }} · 特征 {{ s.feature_count }} · {{ s.confirmation_status==='confirmed'?'已人工确认':'已停用' }}</p></div><button v-if="s.confirmation_status==='confirmed'" :disabled="saving" @click="disableSample(s.id)">停用</button></article></div>
      <p v-if="!samples.length">当前身份暂无样本。</p>
      <button :disabled="!groupId||!samples.length||busy||saving" @click="rebuildGroup">重建当前身份的特征缓存</button>
    </section>
    <section class="card">
      <h2>{{ mode==='reference'?'2. 上传历史合同并选择印章':'1. 上传待测文件并选择印章' }}</h2>
      <p>支持 PDF、DOCX、PNG、JPEG、WebP、BMP、TIFF，限 50 MB / 200 页。DOCX 需要本地 LibreOffice，未安装时请导出 PDF。</p>
      <input :key="mode" type="file" accept=".pdf,.docx,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff" :disabled="busy||uploading||saving" aria-label="上传带印章文件" @change="upload" />
      <p v-if="job" role="status">{{ job.fileName }} · {{ statusText }}<span v-if="job.progress"> · {{ job.progress.processedPages }}/{{ job.progress.totalPages }} 页</span></p>
      <p v-if="job?.error" class="error">{{ job.error }}</p>
      <p v-if="job?.rebuildCount">已重建 {{ job.rebuildCount }} 个参考样本的特征，仅影响当前身份。</p>
      <template v-if="job?.pages?.length">
        <div class="tools"><label>页面 <select v-model.number="pageNumber" @change="box=null"><option v-for="p in job.pages" :key="p.page" :value="p.page">第 {{ p.page }} 页 · {{ p.candidates.length }} 个候选</option></select></label><span>点击候选框，或在页面上拖动框选；灰色、淡色印章也可手动选择。</span></div>
        <div class="page-scroll"><div ref="canvas" class="page-canvas" @pointerdown="startBox" @pointermove="moveBox" @pointerup="finishBox" @pointercancel="cancelBox"><img v-if="page" :src="imageUrl(page.image)" alt="合同原页面，可拖动框选印章" draggable="false" /><button v-for="(b,i) in page?.candidates||[]" :key="i" class="candidate" :style="boxStyle(b)" :aria-label="`选择候选印章 ${i+1}`" @pointerdown.stop @click.stop="box={...b}"><span>{{ i+1 }}</span></button><div v-if="box" class="chosen" :style="boxStyle(box)" /></div></div>
        <button class="primary" :disabled="!box||busy||saving" @click="selectBox">{{ mode==='reference'?'预处理所选参考印章':'匹配所选印章' }}</button>
      </template>
    </section>
    <section v-if="job?.crop&&job.status==='done'" class="card">
      <h2>所选印章与处理质量</h2><div class="crops"><figure v-for="[name,title] in [['original.png','原始裁剪'],['red-mask.png','红色掩膜'],['gray.png','灰度图']]" :key="name"><img :src="imageUrl(name)" :alt="title" /><figcaption>{{ title }}</figcaption></figure></div>
      <p>质量 {{ job.crop.qualityScore }} / 100 · 有效特征 {{ job.crop.featureCount }} · {{ job.crop.channel==='red'?'红色特征通道':'灰度通道，需谨慎复核' }}。质量分与匹配分均不是真实性概率。</p>
      <template v-if="mode==='reference'"><label class="confirm"><input v-model="confirmed" type="checkbox" />我已核实历史印章身份，确认它属于当前所选 label。</label><button class="primary" :disabled="!confirmed||!groupId||saving||!!job.savedSample" @click="saveSample">{{ job.savedSample?`已登记样本 #${job.savedSample.id}`:'确认并登记参考样本' }}</button></template>
    </section>
    <section v-if="job?.result&&job.status==='done'" class="card">
      <header><h2>{{ labels[job.result.status] }}</h2><button @click="downloadResult">下载匹配记录</button></header><p>{{ reasons[job.result.reason]||job.result.reason }}</p><p class="notice">{{ job.result.warning }}</p>
      <div class="scores"><div>Top1<strong>{{ value(job.result.top1Score) }}</strong></div><div>Top2<strong>{{ value(job.result.secondBestScore) }}</strong></div><div>分差<strong>{{ value(job.result.scoreGap) }}</strong></div></div>
      <p v-if="job.result.bestMatch">最高得分身份：{{ job.result.bestMatch.label }} · {{ job.result.bestMatch.sealName }} · {{ job.result.bestMatch.companyName }}（仅为候选，须结合当前结论判断）</p><p>引擎：{{ job.result.provider }} · {{ job.result.processingVersion }} · 阈值尚未经过真实人工标签校准</p>
      <div class="table-scroll"><table><thead><tr><th>候选身份</th><th>组得分</th><th>去重来源数</th><th>参考样本与几何证据</th></tr></thead><tbody><tr v-for="r in job.result.ranking" :key="r.id"><td>{{ r.label }}<br />{{ r.sealName }}</td><td>{{ r.score }}</td><td>{{ r.independentSamples }}</td><td><div v-for="s in r.matchedSamples" :key="s.id">#{{ s.id }}：{{ s.score }} 分；有效匹配 {{ s.goodMatches }}，内点 {{ s.inlierCount }}，内点率 {{ Math.round(s.inlierRatio*100) }}%，全特征支持 {{ Math.round((s.featureSupportRatio||0)*100) }}%，查询/参考覆盖 {{ Math.round(s.queryCoverage*100) }}% / {{ Math.round(s.referenceCoverage*100) }}%</div></td></tr></tbody></table></div>
      <figure v-if="job.result.visualSampleId"><img class="match-image" :src="imageUrl('matches.png')" alt="查询印章与参考样本几何内点连线" /><figcaption>查询与样本 #{{ job.result.visualSampleId }} 的几何内点，供人工复核。</figcaption></figure>
    </section>
  </section>
</template>
<script setup>
import { computed,onMounted,onBeforeUnmount,reactive,ref,watch } from 'vue'
const mode=ref('query'),engine=ref('正在检查本地图像环境…'),error=ref(''),groups=ref([]),samples=ref([]),groupId=ref('')
const groupForm=reactive({label:'',sealName:'',companyName:''}),saving=ref(false),uploading=ref(false),job=ref(null),pageNumber=ref(1),box=ref(null),confirmed=ref(false),canvas=ref(null)
let timer,alive=true,requestVersion=0,drag=null
const jobs={query:null,reference:null}
watch(groupId,()=>{confirmed.value=false})
const busy=computed(()=>job.value&&['queued','processing','matching','saving'].includes(job.value.status))
const page=computed(()=>job.value?.pages?.find(p=>p.page===pageNumber.value))
const statusText=computed(()=>({queued:'排队中',processing:'正在渲染并检测候选',ready:'请选择印章',matching:'正在本地处理',done:'处理完成',failed:'处理失败',saving:'保存中'})[job.value?.status]||'')
const labels={MATCH:'匹配历史真实印章',POSSIBLE_MATCH:'疑似匹配历史真实印章',NOT_MATCH:'未匹配到历史真实印章',UNCERTAIN:'匹配结果不确定'}
const reasons={insufficient_library:'参考身份或独立来源不足，请补充已确认样本。',ambiguous_identity:'多个身份得分接近，无法可靠区分。',query_quality_insufficient:'区域模糊或有效特征不足，请上传清晰图像或重新框选。',reference_cache_unavailable:'部分参考特征无法读取，请检查参考库。',historical_visual_match:'几何证据支持历史图像匹配，仍需人工复核。',review_required:'存在相似证据，请人工复核。',not_found_in_current_library:'未在当前库找到足够匹配证据，不代表印章不真实。'}
const value=v=>v===null||v===undefined?'不足以计算':v
async function api(url,options={}){const response=await fetch('/api/seal'+url,options);const data=await response.json().catch(()=>({error:'响应无效，请确认 npm run dev 已启动 API。'}));if(!response.ok)throw new Error(data.error||`请求失败（${response.status}）`);return data}
const post=(url,body)=>api(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
async function refreshGroups(){groups.value=await api('/groups')}
async function rebuildGroup(){error.value='';try{const r=await post(`/groups/${groupId.value}/rebuild`,{});remember(r.id);box.value=null;confirmed.value=false;await poll(r.id,++requestVersion)}catch(e){error.value=e.message}}
async function loadSamples(){samples.value=groupId.value?await api(`/groups/${groupId.value}/samples`).catch(e=>{error.value=e.message;return []}):[]}
async function createGroup(){saving.value=true;error.value='';try{const g=await post('/groups',groupForm);await refreshGroups();groupId.value=String(g.id);await loadSamples()}catch(e){error.value=e.message}finally{saving.value=false}}
async function disableSample(id){if(!window.confirm('确定停用此样本？记录与文件保留，但不再参与匹配。'))return;saving.value=true;try{await post(`/samples/${id}/disable`,{confirmed:true});await refreshGroups();await loadSamples()}catch(e){error.value=e.message}finally{saving.value=false}}
function remember(id){jobs[mode.value]=id;try{sessionStorage.setItem('seal-job-'+mode.value,id)}catch{}}
async function poll(id,version){clearTimeout(timer);try{const data=await api(`/jobs/${id}`);if(!alive||version!==requestVersion)return;job.value=data;if(['queued','processing','matching','saving'].includes(data.status))timer=setTimeout(()=>poll(id,version),1500)}catch(e){if(alive&&version===requestVersion)error.value=e.message}}
function switchMode(next){if(uploading.value||saving.value)return;mode.value=next;requestVersion++;clearTimeout(timer);job.value=null;box.value=null;confirmed.value=false;pageNumber.value=1;error.value='';if(jobs[next])poll(jobs[next],requestVersion)}
async function upload(event){
  const file=event.target.files?.[0]
  if(!file)return
  requestVersion++;clearTimeout(timer);job.value=null;confirmed.value=false;box.value=null;pageNumber.value=1;error.value=''
  jobs[mode.value]=null
  try{sessionStorage.removeItem('seal-job-'+mode.value)}catch{}
  if(file.size>50*1024*1024){error.value='文件超过 50 MB，请拆分后上传。';event.target.value='';return}
  uploading.value=true
  try{
    const form=new FormData();form.append('file',file)
    const r=await api(mode.value==='reference'?'/reference/document':'/analyze',{method:'POST',body:form})
    remember(r.id);await poll(r.id,requestVersion)
  }catch(e){error.value=e.message}finally{uploading.value=false;event.target.value=''}
}
function imageUrl(name){return `/api/seal/jobs/${job.value.id}/images/${name}?v=${encodeURIComponent(JSON.stringify(job.value.selection||{}))}`}
function boxStyle(b){return {left:b.x*100+'%',top:b.y*100+'%',width:b.width*100+'%',height:b.height*100+'%'}}
function point(event){const r=canvas.value.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(event.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(event.clientY-r.top)/r.height))}}
function startBox(event){if(busy.value||event.button!==0)return;drag=point(event);canvas.value.setPointerCapture(event.pointerId);box.value=null}
function moveBox(event){if(!drag)return;const p=point(event);box.value={x:Math.min(drag.x,p.x),y:Math.min(drag.y,p.y),width:Math.abs(p.x-drag.x),height:Math.abs(p.y-drag.y)}}
function finishBox(event){moveBox(event);drag=null;if(box.value&&(box.value.width<.005||box.value.height<.005))box.value=null}
function cancelBox(){drag=null;box.value=null}
async function selectBox(){error.value='';confirmed.value=false;try{await post(`/jobs/${job.value.id}/selection`,{page:pageNumber.value,bbox:box.value});await poll(job.value.id,requestVersion)}catch(e){error.value=e.message}}
async function saveSample(){saving.value=true;error.value='';try{await post('/reference/samples',{jobId:job.value.id,groupId:Number(groupId.value),confirmed:confirmed.value});await poll(job.value.id,requestVersion);await refreshGroups();await loadSamples()}catch(e){error.value=e.message}finally{saving.value=false}}
function downloadResult(){const url=URL.createObjectURL(new Blob([JSON.stringify({fileName:job.value.fileName,selection:job.value.selection,result:job.value.result},null,2)],{type:'application/json;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='印章图像匹配记录.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
onMounted(async()=>{try{for(const k of ['query','reference'])jobs[k]=sessionStorage.getItem('seal-job-'+k)}catch{}if(jobs.query)poll(jobs.query,requestVersion);const c=await Promise.allSettled([api('/health'),refreshGroups()]);if(!alive)return;engine.value=c[0].status==='fulfilled'?`本地 OpenCV ${c[0].value.version} · CPU 已就绪`:'本地图像环境未就绪，请运行 npm run seal:setup';if(c[1].status==='rejected')error.value='参考库读取失败，请检查 MySQL 和 API。'})
onBeforeUnmount(()=>{alive=false;clearTimeout(timer)})
</script>
<style scoped>
.seal-stage{padding:28px;min-width:0;width:100%;overflow:auto;color:#17324a}.seal-stage header{display:flex;justify-content:space-between;gap:18px;align-items:center}.seal-stage h1{font-size:25px;margin:8px 0}.seal-stage h2{font-size:18px;margin:0 0 16px}.seal-stage p{font-size:14px;line-height:1.7;overflow-wrap:anywhere}.seal-stage small{color:#567080}.notice{padding:14px;background:#edf3f8;border-left:3px solid #7891a7}.error{padding:14px;background:#fff0f0;color:#a52424;overflow-wrap:anywhere}.tabs{display:flex;gap:12px;margin:22px 0}.seal-stage button{border:1px solid #bdcbd7;border-radius:7px;background:white;color:#18364d;padding:10px 15px;cursor:pointer;font:inherit;font-size:14px}.seal-stage button:disabled{opacity:.5;cursor:not-allowed}.seal-stage button.primary{background:#2365ce;color:white;border-color:#2365ce}.card{background:white;border:1px solid #d9e3ec;border-radius:9px;padding:22px;margin-bottom:20px}.form{display:flex;gap:12px;flex-wrap:wrap;align-items:end}.form label{display:grid;gap:6px;flex:1;min-width:160px}.seal-stage input:not([type=checkbox]),.seal-stage select{padding:9px;border:1px solid #b9cbd7;border-radius:5px;max-width:100%;font:inherit;font-size:14px}.select{display:flex;gap:14px;align-items:center;margin-top:20px}.select select{flex:1}.samples{max-height:350px;overflow:auto}.samples article{display:flex;gap:14px;align-items:center;border-bottom:1px solid #e4eaf0;padding:12px 0}.samples article>div{flex:1;overflow-wrap:anywhere;min-width:0}.samples img{width:90px;height:90px;object-fit:contain}.samples p{margin:4px 0}.tools{display:flex;gap:20px;align-items:center;margin:16px 0;font-size:13px}.page-scroll{max-height:620px;overflow:auto;background:#e2e8ed;padding:8px;margin:12px 0}.page-canvas{position:relative;max-width:850px;margin:auto;touch-action:none;user-select:none;line-height:0}.page-canvas>img{width:100%;display:block}.seal-stage .candidate{position:absolute;border:2px solid #d29a15;background:rgba(255,220,90,.08);padding:0;border-radius:0}.candidate span{position:absolute;top:0;left:0;line-height:18px;background:#fff1c3;color:#604509;font-size:12px}.chosen{position:absolute;border:3px solid #1373e6;background:rgba(15,100,220,.12);pointer-events:none;box-sizing:border-box}.crops{display:flex;flex-wrap:wrap;gap:20px}.crops figure{margin:0;max-width:30%;min-width:100px}.crops img{width:190px;height:190px;object-fit:contain;border:1px solid #ddd;background:white}.seal-stage figcaption{font-size:13px;color:#526b7f;margin:7px 0}.confirm{display:flex;gap:8px;margin:20px 0;align-items:center}.scores{display:flex;gap:18px}.scores>div{background:#eff4f8;padding:16px;flex:1}.scores strong{display:block;font-size:24px;margin-top:10px}.table-scroll{overflow:auto}.seal-stage table{width:100%;border-collapse:collapse;font-size:13px}.seal-stage th,.seal-stage td{padding:12px;border:1px solid #dae2e9;text-align:left;line-height:1.8}.match-image{max-width:100%;max-height:580px;object-fit:contain}@media(max-width:850px){.seal-stage{padding:16px}.seal-stage header,.tools,.select{align-items:stretch;flex-direction:column}.crops figure{max-width:100%}.scores{flex-wrap:wrap}}
</style>
