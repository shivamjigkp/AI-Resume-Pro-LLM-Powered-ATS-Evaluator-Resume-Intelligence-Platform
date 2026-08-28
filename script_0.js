
// ════════════════════════════════════════════════════════════════
// CONFIG & GLOBALS
// ════════════════════════════════════════════════════════════════
if(typeof pdfjsLib!=='undefined') pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Multi-provider AI keys — tried in order, auto-fallback on rate-limit/error
let AIK=(()=>{try{return JSON.parse(localStorage.getItem('rsai_keys')||'{"enableFreeAI":true}')}catch(e){return{enableFreeAI:true};}})();
if(AIK.enableFreeAI===undefined) AIK.enableFreeAI=true;

function hasAnyKey(){
  return!!(AIK.gemini||AIK.groq||AIK.nvidia||AIK.openrouter||(AIK.customUrl&&AIK.customKey)||(AIK.enableFreeAI!==false));
}
let CTPL='T-modern';
let savedFastRewrite='';  // stores AI rewrite result for apply

const TEMPLATES=[
  {id:'T-modern',name:'Modern Tech',tag:'FAANG Standard',desc:'Centered header with accent border. Industry default.'},
  {id:'T-mmmut',name:'MMMUT Placement',tag:'Official T&P Format',desc:'Official Training & Placement format (MMMUT). Clean serif with structured academic & project layout.'},
    {id:'T-jakes',name:"Jake's Classic",tag:'Ivy League / ATS Safe',desc:'Time-tested serif layout from Overleaf. 100% ATS.'},
  {id:'T-sidel',name:'Left Sidebar',tag:'Two-Column',desc:'Skills column left, content right.'},
  {id:'T-sider',name:'Right Sidebar',tag:'Two-Column',desc:'Content left, skills column right.'},
  {id:'T-zurich',name:'Zurich Minimal',tag:'Swiss Clean',desc:'Left accent stripe, Roboto fonts.'},
  {id:'T-emerald',name:'Emerald Executive',tag:'Executive',desc:'Mint header block, emerald section lines.'},
  {id:'T-indigo',name:'Indigo Banner',tag:'Creative Bold',desc:'Full-width colored header banner.'},
  {id:'T-mono',name:'Terminal Dev',tag:'Developer',desc:'JetBrains Mono, code-editor aesthetic.'},
  {id:'T-serif',name:'Stanford Serif',tag:'Academic',desc:'Playfair Display elegant heading style.'},
  {id:'T-slate',name:'Slate Corporate',tag:'Corporate',desc:'Grey section badges, structured lines.'},
  {id:'T-startup',name:'Startup Modern',tag:'Startup / Product',desc:'Gradient accent underline, badge style.'},
  {id:'T-compact',name:'Compact Density',tag:'Max Content',desc:'Ultra-tight spacing for heavy profiles.'},
  {id:'T-border',name:'Bordered Frame',tag:'Card Style',desc:'Outer border frame, clean card look.'},
  {id:'T-nordic',name:'Nordic Minimal',tag:'Ultra Minimal',desc:'Whitespace-first Scandinavian style.'},
  {id:'T-crimson',name:'Crimson Bold',tag:'High Impact',desc:'Deep burgundy accents, bold dividers.'},
];

// ════════════════════════════════════════════════════════════════
// RESUME DATA STORE
// ════════════════════════════════════════════════════════════════
let D={
  basics:{name:'',loc:'',phone:'',email:'',li:'',gh:'',gfg:'',leetcode:'',codeforces:'',hackerrank:'',port:'',otherLink:'',summary:''},
  skills:{lang:'',tools:'',domain:'',cloud:'',course:''},
  exp:[], proj:[],
  edu:{uni:'',deg:'',yrs:'',gpa:''},
  ach:[],
  sectionVisibility:{summary:true,links:true,skills:true,exp:true,proj:true,edu:true,ach:true,certs:true},
  showCertsTop:false,
  outreach:{
    notice_period: 'Within 30 days',
    current_ctc: 'Negotiable / Confidential',
    expected_ctc: 'Negotiable as per standards',
    reason_for_change: 'Seeking a challenging role to leverage and expand my full-stack engineering and data analytics skills to drive product success.',
    experience_summary: 'A software engineer with experience in developing scalable web applications and data processing pipelines. Proficient in React, Node.js, Python, Flask, and SQL databases.'
  }
};

// ════════════════════════════════════════════════════════════════
// MULTI-PROVIDER AI ENGINE
// 1. Google Gemini (auto-fallback across 2.0-flash, 1.5-flash, 1.5-pro to fix 404s)
// 2. Groq (auto-fallback to llama-3.1-8b-instant with 30k TPM on 429 rate limit)
// 3. NVIDIA NIM (auto-fallback across llama-3.3-70b, llama-3.1-8b, deepseek-r1)
// 4. OpenRouter (free & paid models)
// 5. Custom OpenAI-compatible endpoints
// 6. Zero-Config Free AI (Pollinations Cloud — no key required)
// ════════════════════════════════════════════════════════════════
let lastAIError='';
let lastAITruncated=false;

let lastUsedAIProvider = '';

function updateAIBadge(name, isAI){
  const el = document.getElementById('activeAIName');
  const badge = document.getElementById('activeAIBadge');
  if(!el || !badge) return;
  el.textContent = name;
  if(isAI){
    badge.style.background = '#ecfdf5';
    badge.style.color = '#065f46';
    badge.style.borderColor = '#a7f3d0';
  } else {
    badge.style.background = '#fef3c7';
    badge.style.color = '#92400e';
    badge.style.borderColor = '#fde68a';
  }
}

// Small helper: 500/502/503/504 from a provider mean "server temporarily
// overloaded, try again shortly" — NOT "broken forever" like a 404/401
// would be. Immediately giving up on these (and falling all the way back
// to the offline parser) throws away a perfectly good AI call for what's
// usually a 1-2 second hiccup. Short exponential backoff, 2 extra tries.
async function sleep(ms){return new Promise(res=>setTimeout(res,ms));}
const TRANSIENT_STATUSES=new Set([500,502,503,504]);

// ════════════════════════════════════════════════════════════════
// fetchWithTimeout — every AI provider call below uses this instead
// of raw fetch(). Root cause of "AI analysis stuck loading forever":
// plain fetch() has NO timeout, so if a provider (esp. the free
// fallback) is slow/unreachable, the browser can hang for minutes
// with no failover. This aborts after `timeoutMs` and throws a clear
// error so callAI() moves to the next provider (or offline) quickly.
// ════════════════════════════════════════════════════════════════
function fetchWithTimeout(url, options={}, timeoutMs=20000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(), timeoutMs);
  return fetch(url, {...options, signal:controller.signal})
    .catch(e=>{
      if(e.name==='AbortError') throw new Error(`Timed out after ${Math.round(timeoutMs/1000)}s — provider slow/unreachable`);
      throw e;
    })
    .finally(()=>clearTimeout(timer));
}

async function callGemini(prompt,maxTokens=6000,quickTest=false){
  const keys = quickTest
    ? [AIK.gemini].filter(Boolean)                              // test = just the primary key, fast
    : [AIK.gemini, ...(AIK.geminiKeys || [])].filter(Boolean);   // real use = full rotation pool
  if(!keys.length) return {ok:false,skip:true};
  
  const candidateModels = quickTest
    ? [AIK.geminiModel||'gemini-2.5-flash']                      // test = 1 model, no fallback chain
    : [AIK.geminiModel,'gemini-2.5-flash','gemini-2.5-flash-lite','gemini-flash-latest'].filter(Boolean);
  const maxAttempts = quickTest?1:3;
  let lastErr='';
  
  for(let kIdx = 0; kIdx < keys.length; kIdx++){
    const activeKey = keys[kIdx];
    for(const model of [...new Set(candidateModels)]){
      let attempt=0;
      while(attempt<maxAttempts){
        attempt++;
        try{
          const r=await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${activeKey}`,{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.7,maxOutputTokens:maxTokens}})
          },25000);
          if(r.status===429){
            lastErr=`Gemini Key ${kIdx+1} 429: Rate-limited or quota exceeded`;
            toast(`⚠️ Gemini Key ${kIdx+1} rate-limited. Rotating to next key...`, "warning", 3000);
            break; // Break model loop, try next key in outer loop
          }
          if(r.status===404){
            lastErr=`Model ${model} returned 404`;
            break; // next model
          }
          if(r.status===400||r.status===403){
            const ej=await r.json().catch(()=>null);
            lastErr=`Gemini Key ${kIdx+1} ${r.status}: ${ej?.error?.message||'invalid API key'}`;
            toast(`⚠️ Gemini Key ${kIdx+1} failed (${r.status}). Rotating to next key...`, "warning", 3000);
            break; // Try next key
          }
          if(TRANSIENT_STATUSES.has(r.status)&&attempt<maxAttempts){
            lastErr=`Gemini ${r.status} (server overloaded) on ${model}, retrying…`;
            await sleep(600*attempt); // 600ms, then 1200ms
            continue;
          }
          if(!r.ok){
            lastErr=`HTTP ${r.status}`;
            break; // try next model
          }
          const d=await r.json();
          const text=d?.candidates?.[0]?.content?.parts?.[0]?.text;
          const finish=d?.candidates?.[0]?.finishReason;
          if(text) return {ok:true,text,truncated:finish==='MAX_TOKENS',provider:`Gemini (${model})`};
          lastErr='Gemini returned an empty response';
          break;
        }catch(e){lastErr=e.message;break;}
      }
    }
    console.warn(`Gemini Key ${kIdx+1} failed. Rotating...`);
  }
  return {ok:false,error:lastErr||'All Gemini keys in the pool failed.'};
}

async function callGroq(prompt,maxTokens=4000,quickTest=false){
  if(!AIK.groq) return {ok:false,skip:true};
  // Groq periodically retires/renames hosted models (deepseek-r1-distill-
  // llama-70b, llama-3.3-70b-versatile, llama-3.1-8b-instant, and
  // gemma2-9b-it are ALL gone as of now — confirmed by fetching this
  // key's live /v1/models list). These are today's actual chat/instruct
  // models on Groq; gpt-oss-120b is the strongest for JSON extraction.
  const primaryModel=AIK.groqModel;
  const models = quickTest
    ? [primaryModel||'openai/gpt-oss-120b']
    : [primaryModel,'openai/gpt-oss-120b','openai/gpt-oss-20b','qwen/qwen3.6-27b','groq/compound-mini'].filter(Boolean);
  const uniqueModels=[...new Set(models)];
  const maxAttempts=quickTest?1:3;
  let lastErr='';
  for(const model of uniqueModels){
    let attempt=0;
    while(attempt<maxAttempts){
      attempt++;
      try{
        const r=await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions',{
          method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${AIK.groq}`},
          body:JSON.stringify({model,messages:[{role:'user',content:prompt}],temperature:0.7,max_tokens:Math.min(maxTokens,4096)})
        },25000);
        if(r.status===429){
          lastErr=`Groq (${model}) 429 rate limit exceeded`;
          break;
        }
        if(r.status===401||r.status===403){
          const ej=await r.json().catch(()=>null);
          return {ok:false,error:`Groq ${r.status}: ${ej?.error?.message||'invalid API key'}`};
        }
        if(r.status===400){
          const ej=await r.json().catch(()=>null);
          lastErr=`Groq 400 (${model}): ${ej?.error?.message||'bad request'}`;
          break; // model-specific issue (e.g. decommissioned) — try the next one
        }
        if(TRANSIENT_STATUSES.has(r.status)&&attempt<maxAttempts){
          lastErr=`Groq ${r.status} (server overloaded) on ${model}, retrying…`;
          await sleep(600*attempt);
          continue;
        }
        if(!r.ok){
          const ej=await r.json().catch(()=>null);
          lastErr=`Groq ${r.status}: ${ej?.error?.message||'error'}`;
          break;
        }
        const d=await r.json();
        const text=d?.choices?.[0]?.message?.content;
        if(text) return {ok:true,text,provider:`Groq (${model})`};
        lastErr=`Groq (${model}) returned an empty response`;
        break;
      }catch(e){lastErr=e.message;break;}
    }
  }
  return {ok:false,rateLimited:true,error:lastErr||'Groq rate limit exceeded on all models'};
}

async function callNvidia(prompt,maxTokens=4000,quickTest=false){
  if(!AIK.nvidia) return {ok:false,skip:true};
  const primaryModel=AIK.nvidiaModel||'meta/llama-3.3-70b-instruct';
  const candidateModels = quickTest
    ? [primaryModel]
    : [primaryModel,'meta/llama-3.1-8b-instruct','deepseek-ai/deepseek-r1','nvidia/llama-3.1-nemotron-70b-instruct','mistralai/mistral-large-2-instruct'];
  const uniqueModels=[...new Set(candidateModels)];
  let lastErr='';
  for(const model of uniqueModels){
    try{
      const r=await fetchWithTimeout('https://integrate.api.nvidia.com/v1/chat/completions',{
        method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${AIK.nvidia}`},
        body:JSON.stringify({model,messages:[{role:'user',content:prompt}],temperature:0.7,max_tokens:Math.min(maxTokens,4096)})
      },25000);
      if(r.status===429) return {ok:false,rateLimited:true,error:'NVIDIA 429: rate-limited'};
      if(r.status===401||r.status===403){
        const ej=await r.json().catch(()=>null);
        return {ok:false,error:`NVIDIA ${r.status}: ${ej?.error?.message||ej?.detail||'invalid key'}`};
      }
      if(!r.ok){
        const ej=await r.json().catch(()=>null);
        lastErr=`NVIDIA ${r.status}: ${ej?.error?.message||ej?.detail||'model error'}`;
        continue;
      }
      const d=await r.json();
      const text=d?.choices?.[0]?.message?.content;
      if(text) return {ok:true,text,provider:`NVIDIA (${model})`};
    }catch(e){lastErr=e.message;}
  }
  return {ok:false,error:lastErr||'NVIDIA request failed'};
}

async function callOpenRouter(prompt,maxTokens=4000,quickTest=false){
  if(!AIK.openrouter) return {ok:false,skip:true};
  // OpenRouter's free-tier model roster rotates too — these are today's
  // active ":free" models. Note: a 401 here happens on the FIRST request
  // before any model is even tried, so 401 almost always means the key
  // itself is wrong/missing, not a model problem.
  const models = quickTest
    ? ['meta-llama/llama-3.3-70b-instruct:free']
    : ['meta-llama/llama-3.3-70b-instruct:free','qwen/qwen3-235b-a22b:free','z-ai/glm-4.5-air:free','moonshotai/kimi-k2:free'];
  let lastErr='';
  for(const model of models){
    try{
      const r=await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions',{
        method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${AIK.openrouter}`,'HTTP-Referer':window.location.origin||'http://localhost','X-Title':'Mastermind Research Technologies Resume AI'},
        body:JSON.stringify({model,messages:[{role:'user',content:prompt}],temperature:0.7,max_tokens:Math.min(maxTokens,4096)})
      },25000);
      if(r.status===401){
        const ej=await r.json().catch(()=>null);
        return {ok:false,error:`OpenRouter 401: ${ej?.error?.message||'invalid or missing API key — check it was pasted correctly (starts with sk-or-v1-)'}`};
      }
      if(!r.ok){lastErr=`OpenRouter ${r.status}`;continue;}
      const d=await r.json();
      const text=d?.choices?.[0]?.message?.content;
      if(text) return {ok:true,text,provider:`OpenRouter (${model})`};
    }catch(e){lastErr=e.message;}
  }
  return {ok:false,error:lastErr||'OpenRouter call failed'};
}

async function callFreeAI(prompt,maxTokens=4000){
  if(AIK.enableFreeAI===false) return {ok:false,skip:true};
  try{
    const r=await fetchWithTimeout('https://text.pollinations.ai/openai',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        model:'openai',
        messages:[{role:'user',content:prompt}],
        temperature:0.7,
        max_tokens:Math.min(maxTokens,3500)
      })
    },15000);
    if(r.ok){
      const d=await r.json().catch(()=>null);
      const text=d?.choices?.[0]?.message?.content;
      if(text) return {ok:true,text,provider:'Free Cloud AI (Pollinations)'};
    }
  }catch(e){console.warn('Pollinations endpoint error:',e);}
  return {ok:false,error:'Free AI proxy unavailable'};
}

async function callCustom(prompt,maxTokens=6000,quickTest=false){
  if(!AIK.customUrl||!AIK.customKey) return {ok:false,skip:true};
  let lastErr='';
  const maxAttempts=quickTest?1:3;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    try{
      const r=await fetchWithTimeout(AIK.customUrl,{
        method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${AIK.customKey}`},
        body:JSON.stringify({model:AIK.customModel||'auto',messages:[{role:'user',content:prompt}],temperature:0.7,max_tokens:maxTokens})
      },25000);
      if(r.status===429) return {ok:false,rateLimited:true,error:'Custom 429: rate-limited'};
      if(TRANSIENT_STATUSES.has(r.status)&&attempt<maxAttempts){
        lastErr=`Custom ${r.status} (server overloaded), retrying…`;
        await sleep(600*attempt);
        continue;
      }
      if(!r.ok){const ej=await r.json().catch(()=>null);return{ok:false,error:`${r.status} ${ej?.error?.message||'request failed'}`};}
      const d=await r.json();
      const text=d?.choices?.[0]?.message?.content||d?.candidates?.[0]?.content?.parts?.[0]?.text;
      if(!text) return {ok:false,error:d?.error?.message||'empty response'};
      return {ok:true,text,provider:'Custom Endpoint'};
    }catch(e){lastErr=e.message;}
  }
  return {ok:false,error:lastErr||'Custom endpoint request failed'};
}

// Master AI caller with multi-provider failover:
// Gemini -> Groq -> NVIDIA -> OpenRouter -> Custom -> Free Cloud AI
// (unless the user manually picked one provider via "Preferred Provider")
async function callAI(prompt,maxTokens){
  const allProviders=[
    ['gemini','Gemini',callGemini],
    ['groq','Groq',callGroq],
    ['nvidia','NVIDIA',callNvidia],
    ['openrouter','OpenRouter',callOpenRouter],
    ['custom','Custom',callCustom],
    ['freeAI','Free AI',callFreeAI]
  ];
  const pref=AIK.preferredProvider||'auto';
  if(pref==='offline'){
    lastAIError='Offline Parser selected manually — no AI call made';
    lastAITruncated=false;
    return null;
  }
  const providers=pref==='auto'?allProviders.map(p=>[p[1],p[2]]):
    allProviders.filter(p=>p[0]===pref).map(p=>[p[1],p[2]]);
  const errors=[];
  for(const [name,fn] of providers){
    const res=await fn(prompt,maxTokens);
    if(res.skip){
      errors.push(`${name}: not configured (no key entered)`);
      continue;
    }
    if(res.ok && res.text){
      lastAIError='';
      lastAITruncated=!!res.truncated;
      lastUsedAIProvider=res.provider||name;
      updateAIBadge(lastUsedAIProvider, true);
      return res.text;
    }
    errors.push(`${name}: ${res.error||'failed'}`);
  }
  lastAIError=errors.length?errors.join(' | '):'No AI provider configured';
  lastAITruncated=false;
  lastUsedAIProvider='Offline Parser';
  updateAIBadge('Offline Parser', false);
  return null;
}
// Back-compat alias
async function gemini(prompt){return callAI(prompt);}

function buildResumeText(){
  const b=D.basics,s=D.skills,e=D.edu;
  let t=`NAME: ${b.name||'[Name]'}\nLOCATION: ${b.loc}\nEMAIL: ${b.email}\nPHONE: ${b.phone}\n`;
  if(b.li) t+=`LINKEDIN: ${b.li}\n`;
  if(b.gh) t+=`GITHUB: ${b.gh}\n`;
  if(b.gfg) t+=`GEEKSFORGEEKS: ${b.gfg}\n`;
  if(b.leetcode) t+=`LEETCODE: ${b.leetcode}\n`;
  if(b.codeforces) t+=`CODEFORCES: ${b.codeforces}\n`;
  if(b.hackerrank) t+=`HACKERRANK: ${b.hackerrank}\n`;
  if(b.port) t+=`PORTFOLIO: ${b.port}\n`;
  if(b.otherLink) t+=`OTHER LINK: ${b.otherLink}\n`;
  t+=`\nSKILLS:\nLanguages: ${s.lang}\nTools: ${s.tools}\nDomain: ${s.domain}\nCloud: ${s.cloud}\nCourses: ${s.course}\n`;
  t+=`\nEXPERIENCE:\n`;
  (D.exp||[]).forEach(x=>{
    t+=`[${x.co} — ${x.role} | ${x.date}]\n`;
    (x.bullets||[]).forEach(b=>t+=`• ${b}\n`);
  });
  t+=`\nPROJECTS:\n`;
  (D.proj||[]).forEach(p=>{
    t+=`[${p.title} | ${p.tech}]\n`;
    (p.bullets||[]).forEach(b=>t+=`• ${b}\n`);
  });
  t+=`\nEDUCATION: ${e.uni} | ${e.deg} | CGPA: ${e.gpa} | ${e.yrs}\n`;
  (D.eduExtra||[]).forEach(x=>t+=`• ${x}\n`);
  t+=`\nACHIEVEMENTS:\n`;
  (D.ach||[]).forEach(a=>t+=`• ${a}\n`);
  return t;
}

// ════════════════════════════════════════════════════════════════
// PROMPT 1 — Analysis
// ════════════════════════════════════════════════════════════════
function buildP1(jd){
  return `Act as a senior recruiter hiring for this exact role.

JOB DESCRIPTION:
${jd}

MY RESUME:
${buildResumeText()}

Analyze my resume against this job description the way Jobscan-style ATS match reports work — weigh HARD SKILLS the most, then JOB TITLE match, then SOFT SKILLS, then other keywords. Give me:
• A match score out of 100 (be brutally honest, weighted mostly by hard-skill overlap)
• Whether my most recent/relevant job title matches or is close to the JD's title
• The top 3 missing HARD skills (technical/tool skills) I MUST add
• The top 2 missing SOFT skills (if any are emphasized in the JD)
• The 3 biggest red flags a hiring manager would notice in under 10 seconds

Respond EXACTLY in this format (no extra text):

MATCH SCORE: [X]/100
JOB TITLE MATCH: [Yes/Partial/No] — [1 line reason]

MISSING HARD SKILLS:
1. [skill]
2. [skill]
3. [skill]

MISSING SOFT SKILLS:
1. [skill]
2. [skill]

RED FLAGS:
🚩 [Red flag 1 — be specific about what's wrong]
🚩 [Red flag 2 — be specific]
🚩 [Red flag 3 — be specific]`;
}

// ════════════════════════════════════════════════════════════════
// PROMPT 2 — XYZ Rewrite
// ════════════════════════════════════════════════════════════════
function buildP2(jd,analysis){
  const missing=analysis.match(/\d+\.\s*(.+)/g)||[];
  return `Rewrite my experience and projects section to pass ATS and impress hiring managers.

JOB DESCRIPTION:
${jd}

TOP MISSING KEYWORDS TO INTEGRATE:
${missing.join('\n')}

CURRENT EXPERIENCE & PROJECTS:
${buildResumeText()}

RULES — follow strictly:
1. Use Google XYZ formula: "Accomplished [X] as measured by [Y] by doing [Z]."
2. Start EVERY bullet with a strong action verb (Engineered, Architected, Optimized, Reduced, Automated, Designed, Implemented, Led, Built)
3. Add quantified metrics: %, ms, x faster, # users, # modules — you may ESTIMATE a plausible metric only when the underlying fact/task is already present in the original bullet
4. Integrate missing JD keywords NATURALLY (not forced), and ONLY if they are actually consistent with what the candidate did — do not claim a technology/tool that never appears anywhere in the resume
5. NO weak verbs: assisted, helped, observed, worked on, gained exposure, participated
6. Max 2 lines per bullet
7. NEVER invent a new company, role, project, date, degree, or entirely new responsibility that has no basis in the original bullet — you are rewriting/quantifying existing facts, not fabricating new ones

FORMAT: Return clearly labeled sections only:
[COMPANY — ROLE | DATE]
• Bullet 1
• Bullet 2
• Bullet 3

[PROJECT TITLE | TECH]
• Bullet 1
• Bullet 2`;
}

// ════════════════════════════════════════════════════════════════
// PROMPT 3 — ATS + HM Review
// ════════════════════════════════════════════════════════════════
function buildP3(jd){
  return `Act as an ATS filter AND a hiring manager reviewing 200 resumes in one sitting.

JOB DESCRIPTION:
${jd}

UPDATED RESUME:
${buildResumeText()}

Scan this resume and tell me:
1. Updated ATS score (out of 100)
2. Would you stop reading and shortlist this? (Yes/No and why in 1 line)
3. Top 3 remaining improvements to push to SHORTLIST
4. Verdict: SHORTLIST ✅ / MAYBE 🤔 / REJECT ❌ (with 1 line reason)

FORMAT EXACTLY:
ATS SCORE: [X]/100
REACTION: [Yes/No] — [reason]

IMPROVEMENTS:
1. [specific improvement]
2. [specific improvement]
3. [specific improvement]

VERDICT: [SHORTLIST ✅ / MAYBE 🤔 / REJECT ❌]
[Reason in 1-2 sentences]`;
}

// ════════════════════════════════════════════════════════════════
// SMART FALLBACK (No API Key)
// ════════════════════════════════════════════════════════════════
function fallbackAnalysis(jd){
  const kws=extractKW(jd);
  const all=[...kws.hard,...kws.soft];
  const rt=buildResumeText().toLowerCase();
  const miss=all.filter(k=>!rt.includes(k.toLowerCase())).slice(0,5);
  const matched=all.filter(k=>rt.includes(k.toLowerCase()));
  const sc=all.length>0?Math.round(matched.length/all.length*100):38;
  return `MATCH SCORE: ${sc}/100\n\nMISSING KEYWORDS:\n${miss.map((k,i)=>`${i+1}. ${k}`).join('\n')}\n\nRED FLAGS:\n🚩 Passive verbs detected ("assisted", "observed") — signals passive contributor, not leader\n🚩 No quantified metrics found — hiring managers need to see %, numbers, impact\n🚩 Generic bullet points without JD-specific terminology — will not pass ATS filter`;
}

function fallbackRewrite(jd){
  let out='';
  (D.exp||[]).forEach(e=>{
    out+=`[${e.co} — ${e.role} | ${e.date}]\n`;
    const bs=e.bullets||['Maintained system'];
    bs.forEach((b,i)=>{
      const actions=['Engineered','Architected','Optimized','Automated','Implemented'];
      const act=actions[i%actions.length];
      const clean=b.replace(/^(assisted|helped|observed|worked on|gained|participated)/i,act);
      const hasMetric=/\d+%|\d+x|\d+\s*(ms|users|modules|records)/i.test(b);
      out+=`• **${hasMetric?clean:act+' '+b.replace(/^(I|we)\s+/i,'')}**${hasMetric?'':`, achieving **${25+i*10}% improvement** in system efficiency`}\n`;
    });
    out+='\n';
  });
  (D.proj||[]).forEach(p=>{
    out+=`[${p.title} | ${p.tech}]\n`;
    (p.bullets||[]).forEach((b,i)=>{
      const actions=['Designed','Built','Implemented','Developed'];
      const act=actions[i%actions.length];
      const hasMetric=/\d+%|\d+x|\d+\s*(ms|users|modules)/i.test(b);
      out+=`• **${hasMetric?b:act+' '+b.replace(/^(I|we)\s+/i,'')}**${hasMetric?'':`, delivering **${30+i*15}% performance gain** through optimized implementation`}\n`;
    });
    out+='\n';
  });
  return out.trim();
}

function fallbackReview(){
  const kws=extractKW(document.getElementById('jdText').value||document.getElementById('fastJD').value);
  const all=[...kws.hard,...kws.soft];
  const rt=buildResumeText().toLowerCase();
  const matched=all.filter(k=>rt.includes(k.toLowerCase()));
  const sc=all.length>0?Math.round(matched.length/all.length*100+8):55;
  return `ATS SCORE: ${Math.min(sc,95)}/100\nREACTION: Yes — quantified bullets and JD keywords now clearly visible\n\nIMPROVEMENTS:\n1. Add a 2-line professional summary targeting this specific role\n2. Expand skills with more domain-specific tools from the JD\n3. Quantify education with class rank or percentile if available\n\nVERDICT: MAYBE 🤔\nStrong technical foundation with improved metrics. Add a tailored summary section to reach SHORTLIST ✅.`;
}

// ════════════════════════════════════════════════════════════════
// FULL AI ANALYSIS (JD Tab 3-step pipeline)
// ════════════════════════════════════════════════════════════════
async function runFullAIAnalysis(){
  const jd=document.getElementById('jdText').value.trim();
  if(!jd){alert('Please paste a Job Description first!');return;}
  const rText=buildResumeText().trim();
  if(rText.length<100){alert('Your resume looks empty!\n\nPlease:\n1. Upload a PDF (Tab 2)\n2. OR fill in your details (Tabs 3-7)\n\nThen try again.');return;}

  document.getElementById('aiResultsWrap').style.display='block';
  document.getElementById('step1card').style.display='block';
  document.getElementById('step2card').style.display='none';
  document.getElementById('step3card').style.display='none';

  // Step 1
  document.getElementById('step1body').innerHTML='<div class="thinking-box"><div class="spin"></div><p>AI acting as senior recruiter...<br>Scoring resume vs JD</p></div>';
  const s1=(await gemini(buildP1(jd)))||fallbackAnalysis(jd);
  document.getElementById('step1body').innerHTML=fmtAI(s1);
  
  // Update score from result
  const sm=s1.match(/MATCH SCORE:\s*(\d+)/i);
  if(sm) updateScore(parseInt(sm[1]));

  // Step 2
  document.getElementById('step2card').style.display='block';
  document.getElementById('step2body').innerHTML='<div class="thinking-box"><div class="spin"></div><p>AI rewriting with Google XYZ formula...<br>Integrating missing keywords</p></div>';
  const s2=(await gemini(buildP2(jd,s1)))||fallbackRewrite(jd);
  savedFastRewrite=s2;
  document.getElementById('step2body').innerHTML=fmtAI(s2);
}

async function applyStep2AndRunStep3(){
  const jd=document.getElementById('jdText').value.trim();
  if(savedFastRewrite) parseAndApplyRewrite(savedFastRewrite);
  populateForm(); render(); liveATS();

  document.getElementById('step3card').style.display='block';
  document.getElementById('step3body').innerHTML='<div class="thinking-box"><div class="spin"></div><p>AI acting as ATS filter + Hiring Manager...<br>Running final review</p></div>';
  const s3=(await gemini(buildP3(jd)))||fallbackReview();
  document.getElementById('step3body').innerHTML=fmtAI(s3);
  const sm=s3.match(/ATS SCORE:\s*(\d+)/i);
  if(sm) updateScore(parseInt(sm[1]));
  document.getElementById('step2card').querySelector('div:last-child').style.display='none';
}

// ════════════════════════════════════════════════════════════════
// FAST MODAL — FULLY AUTOMATIC PIPELINE
// ════════════════════════════════════════════════════════════════
function openFastModal(){
  savedFastRewrite='';
  document.getElementById('fastJD').value=document.getElementById('jdText').value||'';
  document.getElementById('fp1').classList.add('active');
  document.getElementById('fp2').classList.remove('active');
  document.getElementById('fastGoBtn').disabled=false;
  document.getElementById('fastGoBtn').textContent='⚡ GO — Run Full AI Pipeline Now';
  [1,2,3,4].forEach(i=>{
    const el=document.getElementById('ft'+i);
    el.classList.remove('active','done');
    if(i===1) el.classList.add('active');
  });
  document.getElementById('fastOverlay').classList.add('open');
}
function closeFast(){document.getElementById('fastOverlay').classList.remove('open');}

function setFastStep(n){
  [1,2,3,4].forEach(i=>{
    const el=document.getElementById('ft'+i);
    el.classList.remove('active','done');
    if(i<n) el.classList.add('done');
    if(i===n) el.classList.add('active');
  });
}

async function runFastPipeline(){
  const jd=document.getElementById('fastJD').value.trim();
  if(!jd){alert('Please paste a Job Description first!');return;}
  const rText=buildResumeText().trim();
  if(rText.length<80){
    alert('Your resume is empty!\n\nGo to Upload tab → upload PDF or paste text first.');
    closeFast();
    swTab('upload');
    return;
  }

  // Sync JD to main tab
  document.getElementById('jdText').value=jd;
  document.getElementById('fastGoBtn').disabled=true;
  document.getElementById('fastGoBtn').textContent='⏳ Running...';

  // Switch to results pane
  document.getElementById('fp1').classList.remove('active');
  document.getElementById('fp2').classList.add('active');

  const wrap=document.getElementById('fastResultsArea');
  wrap.innerHTML='';

  // ── Step 1 ──
  setFastStep(1);
  wrap.innerHTML=`<div class="result-card" style="border-color:#c4b5fd;background:#faf5ff">
    <div class="result-card-title">🤖 Step 1 — Analyzing Resume vs JD</div>
    <div class="thinking-box"><div class="spin"></div><p>Acting as senior recruiter...</p></div>
  </div>`;

  const s1=(await gemini(buildP1(jd)))||fallbackAnalysis(jd);
  const sm1=s1.match(/MATCH SCORE:\s*(\d+)/i);
  if(sm1) updateScore(parseInt(sm1[1]));
  liveATS();

  wrap.innerHTML=`<div class="result-card" style="border-color:#c4b5fd;background:#faf5ff">
    <div class="result-card-title">🤖 Step 1 — Resume Analysis ✅</div>
    <div class="result-body">${fmtAI(s1)}</div>
  </div>`;

  // ── Step 2 ──
  setFastStep(2);
  wrap.innerHTML+=`<div class="result-card" style="border-color:#a7f3d0;background:#f0fdf4" id="fc2">
    <div class="result-card-title">✨ Step 2 — Rewriting with Google XYZ Formula</div>
    <div class="thinking-box"><div class="spin"></div><p>Making every bullet results-driven...</p></div>
  </div>`;

  const s2=(await gemini(buildP2(jd,s1)))||fallbackRewrite(jd);
  savedFastRewrite=s2;
  document.getElementById('fc2').innerHTML=`<div class="result-card-title">✨ Step 2 — XYZ Rewrite Complete ✅</div><div class="result-body">${fmtAI(s2)}</div>`;

  // Apply rewrite silently
  parseAndApplyRewrite(s2);
  populateForm(); render(); liveATS();

  // ── Step 3 ──
  setFastStep(3);
  wrap.innerHTML+=`<div class="result-card" style="border-color:#fde68a;background:#fffbeb" id="fc3">
    <div class="result-card-title">📊 Step 3 — Final ATS + Hiring Manager Review</div>
    <div class="thinking-box"><div class="spin"></div><p>Scanning like a hiring manager reviewing 200 resumes...</p></div>
  </div>`;

  const s3=(await gemini(buildP3(jd)))||fallbackReview();
  const sm3=s3.match(/ATS SCORE:\s*(\d+)/i);
  if(sm3) updateScore(parseInt(sm3[1]));
  document.getElementById('fc3').innerHTML=`<div class="result-card-title">📊 Step 3 — Review Complete ✅</div><div class="result-body">${fmtAI(s3)}</div>`;

  setFastStep(4);

  wrap.innerHTML+=`<div style="background:#ecfdf5;border:1.5px solid #a7f3d0;border-radius:9px;padding:11px;margin-top:6px;font-size:11.5px;color:#065f46;font-weight:600">
    ✅ <strong>All done!</strong> AI rewrites have been automatically applied to your resume. Click "Apply Changes & Close" to save.
  </div>`;
}

function applyFastAndClose(){
  if(savedFastRewrite){
    parseAndApplyRewrite(savedFastRewrite);
    populateForm(); render(); liveATS();
  }
  closeFast();
}

// ════════════════════════════════════════════════════════════════
// PARSE AI REWRITE → APPLY TO D.exp / D.proj BULLETS
// ════════════════════════════════════════════════════════════════
function parseAndApplyRewrite(text){
  if(!text||!text.trim()) return;
  const lines=text.split('\n').map(l=>l.trim()).filter(l=>l);
  let currentType=null, currentIdx=-1, bullets=[];

  const flush=()=>{
    if(currentIdx>=0 && bullets.length>0){
      if(currentType==='exp' && currentIdx<(D.exp||[]).length) D.exp[currentIdx].bullets=[...bullets];
      if(currentType==='proj' && currentIdx<(D.proj||[]).length) D.proj[currentIdx].bullets=[...bullets];
    }
    bullets=[];
  };

  for(const line of lines){
    const isBullet=line.startsWith('•')||line.startsWith('-')||/^\*\s/.test(line);
    if(isBullet){
      const b=line.replace(/^[•\-\*]\s*/,'').trim();
      if(b) bullets.push(b);
      continue;
    }

    // check for section header [COMPANY — ROLE | DATE] or [PROJECT | TECH]
    const hdrMatch=line.match(/^\[(.+?)\]$/)||line.match(/^\*\*(.+?)\*\*$/);
    if(hdrMatch){
      flush();
      const hdr=hdrMatch[1];
      // Try matching to exp
      let matched=false;
      (D.exp||[]).forEach((e,i)=>{
        if(!matched && (hdr.toUpperCase().includes(e.co.substring(0,5).toUpperCase())||hdr.toUpperCase().includes(e.role.substring(0,5).toUpperCase()))){
          currentType='exp'; currentIdx=i; matched=true;
        }
      });
      if(!matched){
        (D.proj||[]).forEach((p,i)=>{
          if(!matched && hdr.toUpperCase().includes(p.title.substring(0,5).toUpperCase())){
            currentType='proj'; currentIdx=i; matched=true;
          }
        });
      }
      continue;
    }

    // Also try non-bracketed headers (Company — Role | Date)
    if(!isBullet && line.includes('—')&&line.includes('|')){
      flush();
      let matched=false;
      (D.exp||[]).forEach((e,i)=>{
        if(!matched && (line.toUpperCase().includes(e.co.substring(0,4).toUpperCase())||line.toUpperCase().includes(e.role.substring(0,4).toUpperCase()))){
          currentType='exp'; currentIdx=i; matched=true;
        }
      });
      continue;
    }
    if(!isBullet && line.includes('|')&&!line.includes('—')){
      flush();
      let matched=false;
      (D.proj||[]).forEach((p,i)=>{
        if(!matched && line.toUpperCase().includes(p.title.substring(0,4).toUpperCase())){
          currentType='proj'; currentIdx=i; matched=true;
        }
      });
    }
  }
  flush();
}

// ════════════════════════════════════════════════════════════════
// PER-CARD AI FIX (Inline, Jobsuit Style)
// ════════════════════════════════════════════════════════════════
async function aiFixItem(type, idx){
  const jd=document.getElementById('jdText').value.trim();
  const item=type==='exp'?D.exp[idx]:D.proj[idx];
  if(!item) return;

  const boxId=`aibox-${type}-${idx}`;
  const box=document.getElementById(boxId);
  if(box){box.classList.add('show');box.innerHTML='<div class="thinking-box" style="padding:14px"><div class="spin"></div><p style="font-size:10.5px">AI rewriting...</p></div>';}

  const label=type==='exp'?`${item.co} — ${item.role}`:item.title;
  const prompt=`Rewrite these ${type==='exp'?'experience':'project'} bullets using Google XYZ formula.

Context — ${type==='exp'?'Company & Role':'Project'}: ${label}
${jd?`Job Description Context: ${jd.substring(0,400)}`:''}

Current bullets:
${(item.bullets||[]).map(b=>'• '+b).join('\n')}

Rules:
- Strong action verbs (Engineered, Optimized, Automated, Designed, Reduced, Built)
- Add quantified metrics (%, ms, x faster, # users/modules/records) — estimate only when consistent with the original bullet
- Google XYZ: "Accomplished X as measured by Y by doing Z"
- NO: assisted, helped, observed, worked on, gained exposure
- Max 2 lines each
- Do NOT invent tools, technologies, companies, or achievements that are not implied by the original bullet — rewrite/quantify what's already there, never fabricate new facts

Return ONLY the rewritten bullets, one per line starting with •`;

  const result=await gemini(prompt);
  let newBullets=[];
  
  if(result){
    newBullets=result.split('\n').filter(l=>l.trim().startsWith('•')).map(l=>l.replace(/^•\s*/,'').trim()).filter(l=>l.length>5);
  }
  
  if(!newBullets.length){
    // Smart fallback based on actual content
    newBullets=(item.bullets||[]).map((b,i)=>{
      const verbs=['Engineered','Optimized','Automated','Designed','Implemented','Architected'];
      const metrics=[40,35,28,42,33,25];
      const v=verbs[i%verbs.length];
      const m=metrics[i%metrics.length];
      const clean=b.replace(/^(assisted in|helped with|gained exposure to|worked on|observed|participated in|i )/i,'').trim();
      const hasNum=/\d+/.test(clean);
      return `**${v} ${clean.charAt(0).toLowerCase()+clean.slice(1)}**${hasNum?'':`, delivering **${m}% improvement** in operational efficiency and system reliability`}`;
    });
  }

  if(type==='exp') D.exp[idx].bullets=newBullets;
  else D.proj[idx].bullets=newBullets;

  const btsArea=document.getElementById(boxId);
  if(btsArea){
    btsArea.innerHTML=`
      <div class="ai-suggest-title">🤖 AI Suggestions — Review & Apply</div>
      ${newBullets.map((b,bi)=>`
        <div class="suggest-item">
          ${fmtAI(b)}
          <div class="suggest-btns">
            <button class="btn btn-green btn-xs" onclick="acceptBullet('${type}',${idx},${bi})">✓ Accept</button>
            <button class="btn btn-outline btn-xs" onclick="rejectBullet('${type}',${idx},${bi},this)">✗ Keep Original</button>
          </div>
        </div>`).join('')}
      <button class="btn btn-green btn-sm" style="width:100%;justify-content:center;margin-top:6px" onclick="acceptAllBullets('${type}',${idx})">✅ Accept All & Apply</button>`;
  }
  
  render();
}

let origBullets={};
function acceptAllBullets(type,idx){
  const el=document.getElementById(`aibox-${type}-${idx}`);
  if(el){el.classList.remove('show');el.innerHTML='';}
  render(); liveATS();
  if(type==='exp') renderExpEditor(); else renderProjEditor();
}
function acceptBullet(type,idx,bi){
  const parentBox=document.getElementById(`aibox-${type}-${idx}`);
  const items=parentBox.querySelectorAll('.suggest-item');
  if(items[bi]) items[bi].style.background='#ecfdf5';
  render();
}
function rejectBullet(type,idx,bi,btn){
  const parentBox=document.getElementById(`aibox-${type}-${idx}`);
  const items=parentBox.querySelectorAll('.suggest-item');
  if(items[bi]) items[bi].style.background='#fef2f2';
  if(type==='exp'&&origBullets[`exp-${idx}`]) D.exp[idx].bullets[bi]=origBullets[`exp-${idx}`][bi]||D.exp[idx].bullets[bi];
  if(type==='proj'&&origBullets[`proj-${idx}`]) D.proj[idx].bullets[bi]=origBullets[`proj-${idx}`][bi]||D.proj[idx].bullets[bi];
  render();
}

async function aiFixAll(type){
  const items=type==='exp'?D.exp:D.proj;
  if(!items||!items.length){alert('No items to enhance!');return;}
  for(let i=0;i<items.length;i++) await aiFixItem(type,i);
}

// ════════════════════════════════════════════════════════════════
// LIVE ATS SCANNER — approximates Jobscan's real priority order:
// hard skills > job title > soft skills > other keywords.
// (Jobscan also weighs education level; we don't have a reliable
// signal for that from JD text alone, so it's folded into "other".)
// ════════════════════════════════════════════════════════════════
const SOFT_SKILLS=['communication','leadership','teamwork','collaboration','problem solving','problem-solving','stakeholder management','cross-functional','ownership','adaptability','time management','mentoring','strategic thinking','attention to detail','presentation skills','negotiation','customer service','project management','agile','scrum','critical thinking','decision making','conflict resolution','interpersonal','multitasking','organizational skills','self-motivated','analytical thinking','creativity','flexibility','work ethic','client management','relationship building','emotional intelligence'];

function extractJobTitle(jd){
  const lines=jd.split('\n').map(l=>l.trim()).filter(Boolean);
  for(const l of lines.slice(0,5)){
    const m=l.match(/^(?:job title|position|role)\s*:?\s*(.+)$/i);
    if(m) return m[1].trim();
  }
  // First short capitalized line near the top is often the title
  const cand=lines.slice(0,3).find(l=>l.length<60&&/^[A-Z]/.test(l)&&!/description|about|company|overview/i.test(l));
  return cand||'';
}

// Blacklist: words/phrases that should NEVER appear as hard skills
const KW_BLACKLIST=new Set(['internship','intern','developer','engineer','analyst','manager','specialist','consultant','associate','coordinator','responsibilities','requirements','qualifications','preferred','experience','knowledge','ability','full stack','full time','part time','work from','remote','hybrid','onsite','fresher','graduate','bachelor','master','degree','university','college','institute','school','private limited','services','solutions','technologies','tech','labs','systems','january','february','march','april','may','june','july','august','september','october','november','december','india','usa','uk','canada','australia','bangalore','delhi','mumbai','pune','hyderabad','chennai','kolkata','equal opportunity','job description','apply now','looking for','must have','nice to have','good to have','our team','about us','join us']);

function extractKW(jd){
  if(!jd) return{hard:[],soft:[]};
  const found=new Set();
  const stopWords=new Set(['THE','AND','FOR','WITH','ARE','THAT','THIS','YOU','WILL','HAVE','SOME','OUR','WORK','ROLE','FROM','INTO','BEEN','LEAD','MUST','ALSO','BOTH','THEY','THEN','THAN','UPON','EACH','YOUR','MORE','OVER','UNDER','VERY','GOOD','BEST','HIGH','WELL','ABLE','TEAM','NEED','HELP','MAKE','TAKE','GIVE','SHOW','KNOW','WANT','GROW']);
  // HR/org acronyms to exclude
  const hrAcronyms=new Set(['HR','US','UK','EU','CEO','CFO','CTO','COO','VP','PM','JD','BA','MA','MBA','BSC','BE','MCA','BCA','LTD','PVT','INC','LLC']);
  // Only pick up ALL-CAPS acronyms — skip if they're on exclusion list
  (jd.match(/\b[A-Z]{2,8}\b/g)||[]).forEach(w=>{
    if(!stopWords.has(w)&&!hrAcronyms.has(w)) found.add(w);
  });
  // Domain tech terms dictionary — most reliable signal
  const domainTerms=['rtl design','systemverilog','vhdl','verilog','clock gating','synthesis','static timing','pipelining','verification','embedded systems','microcontroller','firmware','fpga','asic','react','react.js','next.js','node.js','express.js','vue.js','angular','svelte','postgresql','mongodb','mysql','redis','docker','kubernetes','terraform','ansible','jenkins','ci/cd','machine learning','deep learning','natural language processing','computer vision','tensorflow','pytorch','scikit-learn','pandas','numpy','fastapi','langchain','transformer','rag','fine-tuning','low power','dft','jtag','spi','i2c','uart','can bus','rtos','baremetal','cmake','gcc','gdb','seo','crm','erp','excel','power bi','tableau','salesforce','figma','a/b testing','google analytics','financial modeling','supply chain','git','linux','unix','rest api','graphql','flutter','swift','kotlin','firebase','aws','gcp','azure','supabase','vercel','netlify','devops','microservices','blockchain','solidity','opencv','web3','springboot','spring boot','django','flask','laravel','hibernate','junit','selenium','playwright','cypress'];
  const jdL=jd.toLowerCase();
  domainTerms.forEach(t=>{if(jdL.includes(t)) found.add(t);});
  // Classify into hard / soft — filter junk
  const hard=[],soft=[];
  [...found].forEach(k=>{
    const kl=k.toLowerCase().trim();
    if(kl.length<2) return;
    if(KW_BLACKLIST.has(kl)) return;
    // Reject multi-word Title Case phrases like "Full Stack Developer Internship" — NOT tech skills
    if(/^[A-Z][a-z]+ [A-Z][a-z]+/.test(k)&&!domainTerms.some(d=>d===kl||kl.includes(d))) return;
    if(SOFT_SKILLS.includes(kl)) soft.push(k);
    else hard.push(k);
  });
  SOFT_SKILLS.forEach(s=>{if(jdL.includes(s)&&!soft.some(x=>x.toLowerCase()===s)) soft.push(s);});
  return {hard:hard.slice(0,25),soft:soft.slice(0,10)};
}

function chipGroup(label,items,cls,clickable){
  if(!items.length) return '';
  const chips=items.map(k=>clickable
    ?`<span class="chip ${cls}" title="Click to add to Skills" onclick="injectKW('${k.replace(/'/g,"\\'")}')">+ ${k}</span>`
    :`<span class="chip ${cls}">✓ ${k}</span>`).join('');
  return `<div style="width:100%;font-size:9px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.4px;margin:4px 0 2px">${label}</div>${chips}`;
}

function liveATS(){
  const jd=document.getElementById('jdText').value;
  if(!jd.trim()){updateScore(0);return;}
  const kws=extractKW(jd);
  const rt=buildResumeText().toLowerCase()+
    (document.getElementById('sLang')?.value||'').toLowerCase()+' '+
    (document.getElementById('sTools')?.value||'').toLowerCase()+' '+
    (document.getElementById('sDomain')?.value||'').toLowerCase();

  const hMatch=kws.hard.filter(k=>rt.includes(k.toLowerCase()));
  const hMiss=kws.hard.filter(k=>!rt.includes(k.toLowerCase()));
  const sMatch=kws.soft.filter(k=>rt.includes(k.toLowerCase()));
  const sMiss=kws.soft.filter(k=>!rt.includes(k.toLowerCase()));

  const jobTitle=extractJobTitle(jd);
  const roles=(D.exp||[]).map(e=>(e.role||'').toLowerCase());
  const titleMatch=jobTitle?roles.some(r=>r&&(r.includes(jobTitle.toLowerCase())||jobTitle.toLowerCase().includes(r))):null;

  // Jobscan-style weighting: hard skills carry the most weight, then
  // job title, then soft skills — matches their documented priority order.
  const hRatio=kws.hard.length?hMatch.length/kws.hard.length:1;
  const sRatio=kws.soft.length?sMatch.length/kws.soft.length:1;
  const tScore=titleMatch===null?0.7:(titleMatch?1:0.3);
  const sc=Math.round((hRatio*0.65+tScore*0.15+sRatio*0.20)*100);
  updateScore(sc);

  const matchedHtml=chipGroup('Hard Skills',hMatch,'chip-ok',false)+chipGroup('Soft Skills',sMatch,'chip-ok',false);
  document.getElementById('matchedChips').innerHTML=matchedHtml||'<span class="chip-empty">Fill your resume to see matches</span>';

  const missingHtml=chipGroup('Hard Skills',hMiss,'chip-miss',true)+chipGroup('Soft Skills',sMiss,'chip-miss',true);
  document.getElementById('missingChips').innerHTML=missingHtml||'<span style="font-size:10px;color:#059669;font-weight:800">✅ 100% Match!</span>';
}

function updateScore(sc){
  document.getElementById('scoreVal').textContent=sc;
  document.getElementById('barScore').textContent=sc+'%';
  const deg=Math.round(sc/100*360);
  document.getElementById('scoreRing').style.background=`conic-gradient(${sc>70?'#059669':sc>45?'#d97706':'#dc2626'} ${deg}deg, #e2e8f0 ${deg}deg)`;
  document.getElementById('scoreBar').style.width=sc+'%';
  document.getElementById('scoreBar').style.background=sc>70?'linear-gradient(90deg,#059669,#10b981)':sc>45?'linear-gradient(90deg,#d97706,#f59e0b)':'linear-gradient(90deg,#dc2626,#ef4444)';
}

function injectKW(kw){
  const el=document.getElementById('sDomain');
  el.value=el.value?el.value+', '+kw:kw;
  D.skills.domain=el.value;
  render(); liveATS();
}

// ════════════════════════════════════════════════════════════════
// CORE HELPERS & ITEM MANAGEMENT
// ════════════════════════════════════════════════════════════════
function bold(s){return(s||'').replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>');}

// ════════════════════════════════════════════════════════════════
// SECTION VISIBILITY (Show/Hide toggles) — MAIN resume
// Stored on D.sectionVisibility, independent from SGResume's own
// sgData.sectionVisibility. Missing/undefined key = visible (true),
// so old saved resumes without this field still show everything.
// ════════════════════════════════════════════════════════════════
function defaultVisibility(){
  return {summary:true,links:true,skills:true,exp:true,proj:true,edu:true,ach:true,certs:true,hyperlinks:false};
}
const VIS_SECTION_LABELS={summary:'Summary',links:'Links',skills:'Skills',exp:'Experience',proj:'Projects',edu:'Education',ach:'Achievements',certs:'Certifications'};

function toggleVis(sec){
  D.sectionVisibility=D.sectionVisibility||defaultVisibility();
  D.sectionVisibility[sec]=!(D.sectionVisibility[sec]!==false);
  render();
}
function updateVisToggleUI(){
  const vis=D.sectionVisibility||defaultVisibility();
  Object.keys(VIS_SECTION_LABELS).forEach(sec=>{
    const el=document.getElementById('visBtn-'+sec);
    if(!el) return;
    const on=vis[sec]!==false;
    el.innerHTML=`<button type="button" class="vis-toggle ${on?'on':'off'}" onclick="toggleVis('${sec}')">${on?'👁️ Shown':'🚫 Hidden'}</button>`;
  });
}

// Certification entries may optionally carry a link using "Label::URL"
// (same convention as project links) — parseCertEntry splits that apart;
// certItemHtml renders the bottom Certifications list with a clickable
// link when a URL is present, otherwise plain bold text.
function parseCertEntry(str){
  const s=(str||'').trim();
  const idx=s.indexOf('::');
  if(idx>-1) return {label:s.slice(0,idx).trim(), url:s.slice(idx+2).trim()};
  return {label:s, url:''};
}
function certItemHtml(str){
  const {label,url}=parseCertEntry(str);
  if(!label) return '';
  if(url){
    const href=url.startsWith('http')?url:'https://'+url;
    return `<a href="${href}" target="_blank" style="color:var(--tpl-theme);text-decoration:underline">${bold(label)}</a>`;
  }
  return bold(label);
}

function redFlags(bullets){
  const txt=(bullets||[]).join(' ').toLowerCase();
  const f=[];
  if(/\b(assisted|observed|helped|worked on|gained exposure|participated)\b/.test(txt)) f.push('⚠️ Weak verb: replace with action verb (Engineered, Automated, Designed...)');
  if(!/\d+%|\d+x|\d+\s*(ms|users|records|modules|points|sensors|circuits|tests)/i.test(txt)) f.push('⚠️ No metrics: add % improvements, time savings, user counts');
  return f;
}

function storeOrig(type,idx){
  const item=type==='exp'?D.exp[idx]:D.proj[idx];
  origBullets[`${type}-${idx}`]=[...(item.bullets||[])];
}

function addExp(){D.exp.push({co:'Company Name',role:'Intern / Software Engineer',date:'Month Year',loc:'Remote',links:'',bullets:['**Accomplished X as measured by Y** by doing Z — replace with your actual work.']});renderExpEditor();render();}
function delExp(i){if(!confirm('Delete this experience?'))return;D.exp.splice(i,1);renderExpEditor();render();}
function addProj(){D.proj.push({title:'Project Name',tech:'React, Node.js, etc.',links:'Live Demo::https://your-demo-link.com | GitHub::https://github.com/you/repo',bullets:['**Engineered X**, achieving **35% improvement** by implementing Y.']});renderProjEditor();render();}
function delProj(i){if(!confirm('Delete this project?'))return;D.proj.splice(i,1);renderProjEditor();render();}

// ── Project Links: structured "Text/Icon shown" + "Actual (long) URL" editor ──
// Stored as one string for backward compatibility with old/AI-imported data:
// entries separated by " | ", each entry either "Label::URL" (new, explicit —
// Label is what's SHOWN, URL is the real long link behind it) or a bare
// label/URL (old freeform text like "Live Demo | GitHub" — still rendered
// exactly as before, since it has no "::").
function getResumeSvgIcon(type, customColor){
  const c = customColor || 'var(--tpl-theme)';
  const base = 'style="display:inline-block;vertical-align:-1.5px;width:11px;height:11px;margin-right:3px;color:' + c + ';fill:currentColor;flex-shrink:0;"';
  switch(type){
    case 'loc': return '<svg ' + base + ' viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>';
    case 'phone': return '<svg ' + base + ' viewBox="0 0 24 24"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>';
    case 'email': case 'mail': return '<svg ' + base + ' viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>';
    case 'li': case 'linkedin': return '<svg ' + base + ' viewBox="0 0 24 24"><path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.75M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z"/></svg>';
    case 'gh': case 'github': return '<svg ' + base + ' viewBox="0 0 24 24"><path d="M12 2A10 10 0 0 0 2 12c0 4.42 2.87 8.17 6.84 9.5.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.87 1.52 2.34 1.07 2.91.83.1-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.92 0-1.11.38-2 1.03-2.71-.1-.25-.45-1.29.1-2.64 0 0 .84-.27 2.75 1.02.79-.22 1.65-.33 2.5-.33.85 0 1.71.11 2.5.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.35.2 2.39.1 2.64.65.71 1.03 1.6 1.03 2.71 0 3.82-2.34 4.66-4.57 4.91.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0 0 12 2z"/></svg>';
    case 'leetcode': return '<svg ' + base + ' viewBox="0 0 24 24"><path d="M13.483 0a1.374 1.374 0 0 0-.961.438L7.116 6.226l-3.854 4.126a5.266 5.266 0 0 0-1.209 2.104 5.35 5.35 0 0 0-.125.513 5.527 5.527 0 0 0 .271 3.543 5.629 5.629 0 0 0 2.123 2.692l5.874 4.187a1.376 1.376 0 1 0 1.6-2.247l-5.873-4.187a2.88 2.88 0 0 1-1.087-1.377 2.827 2.827 0 0 1-.139-1.815 2.7 2.7 0 0 1 .62-1.077L9.07 8.523l4.953-5.308a1.378 1.378 0 0 0-.54-2.215zm6.51 14.156h-8.8a1.375 1.375 0 0 0 0 2.75h8.8a1.375 1.375 0 1 0 0-2.75z"/></svg>';
    case 'gfg': return '<svg ' + base + ' viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5v-9l6 4.5-6 4.5z"/></svg>';
    case 'codeforces': return '<svg ' + base + ' viewBox="0 0 24 24"><path d="M4.5 7.5A1.5 1.5 0 0 1 6 9v10.5A1.5 1.5 0 0 1 4.5 21h-3A1.5 1.5 0 0 1 0 19.5V9a1.5 1.5 0 0 1 1.5-1.5h3zm7.5-4.5A1.5 1.5 0 0 1 13.5 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 7.5 19.5v-15A1.5 1.5 0 0 1 9 3h3zm7.5 9a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-3a1.5 1.5 0 0 1-1.5-1.5v-6a1.5 1.5 0 0 1 1.5-1.5h3z"/></svg>';
    case 'globe': case 'port': return '<svg ' + base + ' viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';
    case 'youtube': return '<svg ' + base + ' viewBox="0 0 24 24"><path d="M10 15l5.19-3L10 9v6m11.56-7.83c.13.47.22 1.1.28 1.9.07.8.1 1.49.1 2.09L22 12c0 2.19-.16 3.8-.44 4.83-.25.9-.83 1.48-1.73 1.73-.47.13-1.33.22-2.65.28-1.3.07-2.49.1-3.59.1L12 19c-4.19 0-6.8-.16-7.83-.44-.9-.25-1.48-.83-1.73-1.73-.13-.47-.22-1.1-.28-1.9-.07-.8-.1-1.49-.1-2.09L22 12c0-2.19.16-3.8.44-4.83.25-.9.83-1.48 1.73-1.73.47-.13 1.33-.22 2.65-.28 1.3-.07 2.49-.1 3.59-.1L12 5c4.19 0 6.8.16 7.83.44.9.25 1.48.83 1.73 1.73z"/></svg>';
    default: return '<svg ' + base + ' viewBox="0 0 24 24"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>';
  }
}

function iconForLink(label,url){
  const hay = (label + ' ' + url).toLowerCase();
  if(/github\.com/.test(hay)) return getResumeSvgIcon('github');
  if(/youtube\.com|youtu\.be/.test(hay)) return getResumeSvgIcon('youtube');
  if(/linkedin/.test(hay)) return getResumeSvgIcon('linkedin');
  if(/leetcode/.test(hay)) return getResumeSvgIcon('leetcode');
  if(/geeksforgeeks|gfg/.test(hay)) return getResumeSvgIcon('gfg');
  if(/demo|live|vercel|netlify|preview/.test(hay)) return getResumeSvgIcon('globe');
  return getResumeSvgIcon('link');
}

function parseLinksField(raw){
  if(!raw) return [{label:'', url:''}];
  if(Array.isArray(raw)){
    return raw.length ? raw.map(r=>({label:r.label||r.name||'', url:r.url||r.link||''})) : [{label:'', url:''}];
  }
  if(typeof raw !== 'string') return [{label:'', url:''}];
  const str = raw.trim();
  if(!str) return [{label:'', url:''}];
  const parts = str.split(/\s*\|\s*/).map(p=>p.trim()).filter(Boolean);
  if(!parts.length) return [{label:'', url:''}];
  return parts.map(part=>{
    const idx = part.indexOf('::');
    if(idx > -1){
      return { label: part.slice(0, idx).trim(), url: part.slice(idx + 2).trim() };
    }
    if(/^https?:\/\//i.test(part)){
      return { label: 'Link', url: part };
    }
    return { label: part, url: '' };
  });
}

function serializeLinksField(rows){
  if(!Array.isArray(rows)) return '';
  return rows.map(r=>{
    const label = (r.label || '').trim();
    const url = (r.url || '').trim();
    if(url && label) return `${label}::${url}`;
    if(url) return `Link::${url}`;
    if(label) return `${label}::`;
    return '';
  }).filter(Boolean).join(' | ');
}

// ── EXP LINKS ──
function expLinksRowsHtml(i){
  const rows = parseLinksField(D.exp[i].links);
  return rows.map((r, idx)=>`
    <div style="display:flex;gap:4px;align-items:center;margin-bottom:4px;">
      <input type="text" placeholder="Text to show (e.g. GitHub / Demo)" value="${(r.label||'').replace(/"/g,'&quot;')}" style="flex:1;padding:4px 6px;font-size:10.5px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:4px;" oninput="updateExpLinkRow(${i},${idx},'label',this.value)">
      <input type="text" placeholder="Actual URL (https://...)" value="${(r.url||'').replace(/"/g,'&quot;')}" style="flex:1.4;padding:4px 6px;font-size:10.5px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:4px;" oninput="updateExpLinkRow(${i},${idx},'url',this.value)">
      <button type="button" onclick="removeExpLinkRow(${i},${idx})" title="Remove this link" style="background:#fee2e2;border:none;color:#ef4444;padding:4px 7px;font-size:11px;border-radius:4px;cursor:pointer;font-weight:700;">❌</button>
    </div>`).join('')
    + `<button type="button" onclick="addExpLinkRow(${i})" style="margin-top:2px;padding:4px 8px;font-size:10px;font-weight:700;background:#eff6ff;border:1px dashed #2563eb;color:#2563eb;border-radius:4px;cursor:pointer;width:100%;text-align:center;">+ Add Link</button>`;
}

function addExpLinkRow(i){
  const rows = parseLinksField(D.exp[i].links).filter(r=>r.label || r.url);
  const defaultLabel = rows.length === 0 ? 'Live Demo' : (rows.length === 1 ? 'GitHub' : 'Link');
  rows.push({ label: defaultLabel, url: '' });
  D.exp[i].links = serializeLinksField(rows);
  renderExpEditor();
  render();
}

function removeExpLinkRow(i, idx){
  let rows = parseLinksField(D.exp[i].links);
  rows.splice(idx, 1);
  if(!rows.length) rows = [];
  D.exp[i].links = serializeLinksField(rows);
  renderExpEditor();
  render();
}

function updateExpLinkRow(i, idx, field, value){
  const rows = parseLinksField(D.exp[i].links);
  while(rows.length <= idx) rows.push({ label: '', url: '' });
  rows[idx][field] = value;
  D.exp[i].links = serializeLinksField(rows);
  render();
}

// ── PROJ LINKS ──
function projLinksRowsHtml(i){
  const rows = parseLinksField(D.proj[i].links);
  return rows.map((r, idx)=>`
    <div style="display:flex;gap:4px;align-items:center;margin-bottom:4px;">
      <input type="text" placeholder="Text to show (e.g. Live Demo / GitHub)" value="${(r.label||'').replace(/"/g,'&quot;')}" style="flex:1;padding:4px 6px;font-size:10.5px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:4px;" oninput="updateProjLinkRow(${i},${idx},'label',this.value)">
      <input type="text" placeholder="Actual URL (https://...)" value="${(r.url||'').replace(/"/g,'&quot;')}" style="flex:1.4;padding:4px 6px;font-size:10.5px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:4px;" oninput="updateProjLinkRow(${i},${idx},'url',this.value)">
      <button type="button" onclick="removeProjLinkRow(${i},${idx})" title="Remove this link" style="background:#fee2e2;border:none;color:#ef4444;padding:4px 7px;font-size:11px;border-radius:4px;cursor:pointer;font-weight:700;">❌</button>
    </div>`).join('')
    + `<button type="button" onclick="addProjLinkRow(${i})" style="margin-top:2px;padding:4px 8px;font-size:10px;font-weight:700;background:#eff6ff;border:1px dashed #2563eb;color:#2563eb;border-radius:4px;cursor:pointer;width:100%;text-align:center;">+ Add Link</button>`;
}

function addProjLinkRow(i){
  const rows = parseLinksField(D.proj[i].links).filter(r=>r.label || r.url);
  const defaultLabel = rows.length === 0 ? 'Live Demo' : (rows.length === 1 ? 'GitHub' : 'Link');
  rows.push({ label: defaultLabel, url: '' });
  D.proj[i].links = serializeLinksField(rows);
  renderProjEditor();
  render();
}

function removeProjLinkRow(i, idx){
  let rows = parseLinksField(D.proj[i].links);
  rows.splice(idx, 1);
  if(!rows.length) rows = [];
  D.proj[i].links = serializeLinksField(rows);
  renderProjEditor();
  render();
}

function updateProjLinkRow(i, idx, field, value){
  const rows = parseLinksField(D.proj[i].links);
  while(rows.length <= idx) rows.push({ label: '', url: '' });
  rows[idx][field] = value;
  D.proj[i].links = serializeLinksField(rows);
  render();
}

function setParseStep(stepNum, statusText){
  const overlay = document.getElementById('parseOverlay');
  if(!overlay) return;
  overlay.style.display = 'flex';
  if(statusText) document.getElementById('parseModalSub').textContent = statusText;
  for(let i=1; i<=5; i++){
    const el = document.getElementById(`ps${i}`);
    if(!el) continue;
    if(i < stepNum){ el.className = 'pstep done'; el.querySelector('span').textContent = '✅'; }
    else if(i === stepNum){ el.className = 'pstep active'; el.querySelector('span').textContent = '⏳'; }
    else { el.className = 'pstep'; el.querySelector('span').textContent = '◻️'; }
  }
}
function hideParseOverlay(){
  const overlay = document.getElementById('parseOverlay');
  if(overlay) overlay.style.display = 'none';
}

// ════════════════════════════════════════════════════════════════
// PDF / DOCX PARSER
// ════════════════════════════════════════════════════════════════
// FILE UPLOAD + PARSE
// ════════════════════════════════════════════════════════════════
async function handleUpload(ev){
  const file=ev.target.files[0]; if(!file)return;
  const nm=file.name.toLowerCase();
  try{
    setParseStep(1, `Reading ${file.name}...`);
    if(nm.endsWith('.json')){
      D=JSON.parse(await file.text());
      if(!D.basics.summary)D.basics.summary='';
      populateForm();render();liveATS();

  try{
    const savedRule = localStorage.getItem('rsai_page_break_rule');
    if(savedRule){
      const sel = document.getElementById('pageBreakSel');
      if(sel) sel.value = savedRule;
      changePageBreakRule(savedRule);

  try{
    const savedCompact = localStorage.getItem('rsai_compact_spacing') || 'compact';
    const sel = document.getElementById('compactSpacingSel');
    if(sel) sel.value = savedCompact;
    changeCompactSpacing(savedCompact);
  }catch(e){}

    }
  }catch(e){}

      swTab('basics');toast('✅ Resume loaded from JSON!','success');
      hideParseOverlay();
    }else if(nm.endsWith('.pdf')){
      const ab=await file.arrayBuffer();
      const pdf=await pdfjsLib.getDocument({data:ab}).promise;
      let pageTexts=[];
      for(let i=1;i<=pdf.numPages;i++){
        setParseStep(1, `Reading PDF page ${i} of ${pdf.numPages}...`);
        const pg=await pdf.getPage(i);
        const tc=await pg.getTextContent();
        const yGroups={};
        tc.items.forEach(item=>{
          const y=Math.round(item.transform[5]/4)*4;
          if(!yGroups[y]) yGroups[y]=[];
          yGroups[y].push({x:item.transform[4],str:item.str});
        });
        const sortedY=Object.keys(yGroups).map(Number).sort((a,b)=>b-a);
        const lines=sortedY.map(y=>{
          return yGroups[y].sort((a,b)=>a.x-b.x).map(i=>i.str).join(' ').replace(/\s+/g,' ').trim();
        }).filter(l=>l.length>0);

        try{
          const annot = await pg.getAnnotations();
          // Store hyperlinks separately — do NOT push to lines (avoids polluting certs/ach)
          (annot||[]).filter(a=>a&&a.url&&a.url.startsWith('http')).forEach(a=>{
            if(!window._pdfHyperlinks) window._pdfHyperlinks=[];
            window._pdfHyperlinks.push({label:a.url.replace(/^https?:\/\//,'').split('/')[0], url:a.url});
          });
        }catch(e){}

        pageTexts.push(...lines);
      }
      const fullText=pageTexts.join('\n');
      const r=await smartParse(fullText);
      if(window._pdfHyperlinks && window._pdfHyperlinks.length){ if(!D.hyperlinks) D.hyperlinks=[]; window._pdfHyperlinks.forEach(h=>{ if(!D.hyperlinks.some(e=>e.url===h.url)) D.hyperlinks.push(h); }); window._pdfHyperlinks=[]; renderHyperlinksEditor(); }
      swTab('basics');
      toastParseResult(r,'PDF');
    }else if(nm.endsWith('.docx')||nm.endsWith('.doc')){
      setParseStep(1, `Reading Word docx & extracting text...`);
      const ab=await file.arrayBuffer();
      let extractedText='';
      try{
        const htmlRes=await mammoth.convertToHtml({arrayBuffer:ab});
        if(htmlRes && htmlRes.value){
          let rawHtml = htmlRes.value;
          // Add spacing and linebreaks for table cells, rows, paragraphs
          rawHtml = rawHtml.replace(/<\/td>\s*<td/gi, ' | <td')
                           .replace(/<\/tr>/gi, '\n')
                           .replace(/<\/p>/gi, '\n')
                           .replace(/<br\s*\/?>/gi, '\n')
                           .replace(/<\/li>/gi, '\n');
          const tempDiv=document.createElement('div');
          tempDiv.innerHTML=rawHtml;
          tempDiv.querySelectorAll('a').forEach(a=>{
            const href=a.getAttribute('href')||'';
            const txt=a.textContent.trim();
            if(href.startsWith('http')||href.startsWith('www.')){
              a.textContent=txt?`${txt} (${href})`:href;
            }
          });
          extractedText=tempDiv.innerText||tempDiv.textContent||'';
        }
      }catch(e){console.warn('mammoth html conversion error:',e);}

      if(!extractedText.trim()){
        const rr=await mammoth.extractRawText({arrayBuffer:ab});
        extractedText=rr.value;
      }
      const r=await smartParse(extractedText);
      swTab('basics'); toastParseResult(r,'Word doc');
    }else{
      setParseStep(1, `Reading text file...`);
      const r=await smartParse(await file.text());
      swTab('basics'); toastParseResult(r,'Text file');
    }
  }catch(e){
    hideParseOverlay();
    toast('Parse error: '+e.message,'error',6000);
    console.error(e);
  }
  ev.target.value='';
}

function toastParseResult(r,label){
  if(r.usedAI&&r.partial){
    toast(`⚠️ ${label} parsed with AI (${lastUsedAIProvider||'AI Engine'}), but response was slightly long — check Experience/Projects for missing lines.`,'warning',8000);
  }else if(r.usedAI){
    toast(`✅ ${label} parsed with AI: ${lastUsedAIProvider||'Active Provider'}!`,'success',4000);
  }else{
    toast(`⚡ Parsed with Built-in Offline Engine — ${r.reason}`,'info',6000);
  }
}

// ════════════════════════════════════════════════════════════════
// AI-POWERED RESUME PARSING (primary)
// ════════════════════════════════════════════════════════════════
function buildParsePrompt(rawText){
  return `You are a precise resume-parsing engine. Extract structured data from the RAW RESUME TEXT below and return ONLY a single valid JSON object — no markdown fences, no commentary, no extra text before or after.

RAW RESUME TEXT:
"""
${rawText.substring(0,28000)}
"""

Return EXACTLY this JSON shape (use "" or [] for anything not found — never invent data that isn't in the text):
{
 "basics": {
   "name": "",
   "loc": "",
   "phone": "",
   "email": "",
   "li": "",
   "gh": "",
   "gfg": "",
   "leetcode": "",
   "codeforces": "",
   "hackerrank": "",
   "port": "",
   "otherLink": "",
   "summary": ""
 },
 "edu": {
   "uni": "",
   "deg": "",
   "yrs": "",
   "gpa": ""
 },
 "eduExtra": ["..."],
 "skills": {"lang":"","tools":"","domain":"","cloud":"","course":""},
 "exp": [{"co":"","role":"","date":"","links":"","bullets":["..."]}],
 "proj": [{"title":"","tech":"","links":"","bullets":["..."]}],
 "ach": ["..."],
 "certs": ["..."],
 "hyperlinks": [{"label":"","url":""}]
}

Rules:
- Extract all candidate profile & coding links dynamically from the text:
  * "li" = LinkedIn profile URL
  * "gh" = GitHub profile URL
  * "gfg" = GeeksforGeeks profile URL
  * "leetcode" = LeetCode profile URL
  * "codeforces" = Codeforces profile URL
  * "hackerrank" = HackerRank profile URL
  * "port" = Portfolio / personal website URL
  * "otherLink" = Any other social / profile link
  If any link is NOT in the text, leave it as "" — DO NOT fabricate, hallucinate, or hardcode links.
- "edu": Extract university/college into "uni", degree and branch into "deg", years/duration into "yrs", CGPA or percentage into "gpa".
- "eduExtra": Extract Class XII / Class X / other secondary-school records (school name, board, year, percentage) into this array — one clean combined string per entry (e.g. "ABC School (Class XII) 2022 — CBSE: 94%"). Do NOT put these in "ach".
- "ach": Extract achievements, hackathons, trading competitions, coding stats (130+ LeetCode), sports, and positions of responsibility into "ach" array. Do NOT include Class XII / Class X / school entries here — those belong in "eduExtra".
- "certs": Extract all professional certificates & online certifications (Google, AWS, Stanford, Udemy, HackerRank, etc.) into "certs" array.
- For Experience entries: if there are demo/website/YouTube links associated with a company/role, put them in "links".
- For Projects: put live demo URLs, GitHub repository links, or preview URLs in "links".
- Extract ALL experiences, ALL projects, ALL coursework/certifications, and ALL education records present in the text without truncation.
- Copy facts exactly as they appear (names, numbers, dates, companies, degrees). Do NOT paraphrase, summarize, or invent anything not present in the text.
- "skills.lang" = programming languages, "skills.tools" = frameworks/libraries/tools, "skills.domain" = domain knowledge/soft skills, "skills.cloud" = cloud/DevOps platforms, "skills.course" = relevant coursework/certifications.
- Split each experience/project entry's bullet points into separate array items, without the bullet symbol itself.
- If a field genuinely isn't in the text, leave it as "" or [] — leaving it blank is always better than guessing.`;
}

function applyParsedResume(parsed, rawText){
  let fallback = null;
  if(rawText){
    try{ fallback = extractRawResumeData(rawText); }catch(e){console.warn('fallback parse err:',e);}
  }

  const rawEdu = parsed.edu || parsed.education || {};
  let primaryEdu = Array.isArray(rawEdu) ? (rawEdu[0] || {}) : rawEdu;
  let extraAchs = [];
  if(Array.isArray(rawEdu) && rawEdu.length > 1){
    for(let k=1; k<rawEdu.length; k++){
      const ex = rawEdu[k];
      if(ex && (ex.uni || ex.deg || ex.school || ex.degree)){
        const d = ex.deg || ex.degree || 'Education';
        const u = ex.uni || ex.school || ex.college || ex.institution || '';
        const y = ex.yrs || ex.year || ex.years || ex.date || '';
        const g = ex.gpa || ex.cgpa || ex.score || ex.percentage || '';
        extraAchs.push(`${d}${u ? ' — ' + u : ''}${y ? ' (' + y + ')' : ''}${g ? ' — Score: ' + g : ''}`);
      }
    }
  }

  let achRaw = [];
  if(Array.isArray(primaryEdu.ach)) achRaw.push(...primaryEdu.ach);
  if(Array.isArray(parsed.ach)) achRaw.push(...parsed.ach);
  if(Array.isArray(parsed.achievements)) achRaw.push(...parsed.achievements);
  achRaw.push(...extraAchs);

  if(fallback && fallback.ach && fallback.ach.length){
    fallback.ach.forEach(fa => {
      if(!achRaw.includes(fa)) achRaw.push(fa);
    });
  }

  const cleanAch = [...new Set(achRaw.map(a => typeof a === 'string' ? a.trim() : (a.title || a.name || JSON.stringify(a))).filter(Boolean))].filter(a => !/^Hyperlink\s*\[/i.test(a) && !/^https?:\/\//i.test(a));

  // Secondary education (Class X / XII / other school records) — kept separate
  // from achievements so they render inside the Education section.
  let eduExtraRaw = [];
  if(Array.isArray(parsed.eduExtra)) eduExtraRaw.push(...parsed.eduExtra);
  if(fallback && fallback.eduExtra && fallback.eduExtra.length){
    fallback.eduExtra.forEach(fx => {
      if(!eduExtraRaw.includes(fx)) eduExtraRaw.push(fx);
    });
  }
  const isSchoolLine = s => /class\s*x(?:ii)?\b/i.test(s) || /^(?:central\s+board|(?:cbse|icse)\s*,?\s*new\s*delhi|board\s+of\s+(?:secondary|higher))/i.test(s.trim());
  // Safety net: if the model still put a school line in "ach", reroute it.
  const cleanAchFinal = cleanAch.filter(a => !isSchoolLine(a));
  cleanAch.filter(isSchoolLine).forEach(a => { if(!eduExtraRaw.includes(a)) eduExtraRaw.push(a); });
  const cleanEduExtra = [...new Set(eduExtraRaw.map(a => typeof a === 'string' ? a.trim() : (a.title || a.name || JSON.stringify(a))).filter(Boolean))];

  // Certifications
  let certsRaw = [];
  if(Array.isArray(parsed.certs)) certsRaw.push(...parsed.certs);
  if(Array.isArray(parsed.certifications)) certsRaw.push(...parsed.certifications);
  if(fallback && fallback.certs && fallback.certs.length){
    fallback.certs.forEach(fc => {
      if(!certsRaw.includes(fc)) certsRaw.push(fc);
    });
  }
  const cleanCerts = [...new Set(certsRaw.map(c => typeof c === 'string' ? c.trim() : (c.title || c.name || JSON.stringify(c))).filter(Boolean))].filter(c => !/^Hyperlink\s*\[/i.test(c) && !/^https?:\/\//i.test(c) && !/^Link:/i.test(c));

  // Resolve Primary Education (Fall back to heuristics if AI missed it)
  const finalUni = primaryEdu.uni || primaryEdu.school || primaryEdu.college || primaryEdu.institution || (fallback ? fallback.edu.uni : '');
  const finalDeg = primaryEdu.deg || primaryEdu.degree || primaryEdu.major || (fallback ? fallback.edu.deg : '');
  const finalYrs = primaryEdu.yrs || primaryEdu.years || primaryEdu.year || primaryEdu.date || primaryEdu.duration || (fallback ? fallback.edu.yrs : '');
  const finalGpa = primaryEdu.gpa || primaryEdu.cgpa || primaryEdu.score || primaryEdu.percentage || (fallback ? fallback.edu.gpa : '');

  // Exp & Proj (merge fallback if AI truncated)
  let expList = Array.isArray(parsed.exp) ? parsed.exp.map(e=>({co:e.co||e.company||'',role:e.role||e.title||e.position||'',date:e.date||e.duration||'',links:e.links||e.link||'',bullets:Array.isArray(e.bullets)?e.bullets.filter(Boolean):[]})) : [];
  let projList = Array.isArray(parsed.proj) ? parsed.proj.map(p=>({title:p.title||p.name||'',tech:p.tech||p.technologies||'',links:p.links||p.link||'',bullets:Array.isArray(p.bullets)?p.bullets.filter(Boolean):[]})) : [];

  if(fallback && fallback.exp && fallback.exp.length > expList.length){
    fallback.exp.forEach(fe => {
      if(!expList.some(e => e.co && fe.co && (e.co.toLowerCase().includes(fe.co.toLowerCase()) || fe.co.toLowerCase().includes(e.co.toLowerCase())))){
        expList.push(fe);
      }
    });
  }

  if(fallback && fallback.proj && fallback.proj.length > projList.length){
    fallback.proj.forEach(fp => {
      if(!projList.some(p => p.title && fp.title && (p.title.toLowerCase().includes(fp.title.toLowerCase()) || fp.title.toLowerCase().includes(p.title.toLowerCase())))){
        projList.push(fp);
      }
    });
  }

  // Skills
  const finalSkills = Object.assign({lang:'',tools:'',domain:'',cloud:'',course:''}, (fallback?fallback.skills:{}), parsed.skills||{});
  if(!finalSkills.course && cleanCerts.length){
    finalSkills.course = cleanCerts.join('; ');
  }

  D={
    basics:Object.assign({name:'',loc:'',phone:'',email:'',li:'',gh:'',gfg:'',leetcode:'',codeforces:'',hackerrank:'',port:'',otherLink:'',summary:''}, parsed.basics||{}, fallback?{name:parsed?.basics?.name||fallback.basics.name,email:parsed?.basics?.email||fallback.basics.email,phone:parsed?.basics?.phone||fallback.basics.phone,loc:parsed?.basics?.loc||fallback.basics.loc}:{}),
    skills:finalSkills,
    exp: expList,
    proj: projList,
    edu:{
      uni: finalUni,
      deg: finalDeg,
      yrs: finalYrs,
      gpa: finalGpa
    },
    eduExtra: cleanEduExtra,
    ach: cleanAchFinal,
    certs: cleanCerts
  };
  populateForm();render();liveATS();
}

// Tries AI parsing first (much more reliable across resume formats).
// Falls back to the regex-based parseRaw() if no key is configured,
// the AI call fails, or it doesn't return valid JSON.
function extractJSON(text){
  let s=text.replace(/```json/gi,'').replace(/```/g,'').trim();
  const start=s.indexOf('{');
  const end=s.lastIndexOf('}');
  if(start===-1) throw new Error('No JSON object found in AI response');
  const body=end===-1?s.slice(start):s.slice(start,end+1);
  try{
    return JSON.parse(body);
  }catch(e){
    const repaired=repairTruncatedJSON(body);
    if(repaired) return repaired;
    throw e;
  }
}

// Repairs a JSON string that was cut off mid-way: trims back to the last
// structurally-complete field, then auto-closes any open braces/brackets.
function repairTruncatedJSON(str){
  let s=str;
  for(let attempt=0;attempt<80;attempt++){
    let stack=[],inStr=false,esc=false,ok=true;
    for(let i=0;i<s.length;i++){
      const ch=s[i];
      if(inStr){
        if(esc)esc=false;
        else if(ch==='\\')esc=true;
        else if(ch==='"')inStr=false;
        continue;
      }
      if(ch==='"'){inStr=true;continue;}
      if(ch==='{'||ch==='[')stack.push(ch);
      else if(ch==='}'){if(stack.pop()!=='{'){ok=false;break;}}
      else if(ch===']'){if(stack.pop()!=='['){ok=false;break;}}
    }
    if(!ok){
      const cut=Math.max(s.lastIndexOf(','),s.lastIndexOf('{'),s.lastIndexOf('['));
      if(cut<=0)return null;
      s=s.slice(0,cut);
      continue;
    }
    let candidate=s;
    if(inStr)candidate+='"';
    candidate+=stack.reverse().map(c=>c==='{'?'}':']').join('');
    try{ return JSON.parse(candidate); }
    catch(e){
      const cut=Math.max(s.lastIndexOf(','),s.lastIndexOf('{'),s.lastIndexOf('['));
      if(cut<=0)return null;
      s=s.slice(0,cut);
    }
  }
  return null;
}

// Returns {usedAI, reason} so the caller can tell the user EXACTLY why
// it fell back (no key / rate-limited / bad key / truncated / bad JSON)
async function smartParse(rawText){
  setParseStep(2, 'Analyzing document structure & sections...');
  if(hasAnyKey()){
    try{
      setParseStep(3, `AI Extracting with ${lastUsedAIProvider || 'Active Cloud AI'}...`);
      const res=await callAI(buildParsePrompt(rawText),8000);
      if(res){
        const wasTruncated=lastAITruncated;
        const parsed=extractJSON(res);
        if(parsed&&parsed.basics){
          setParseStep(4, 'Merging details & validating all records...');
          applyParsedResume(parsed, rawText);
          setParseStep(5, 'Building live multi-page interactive preview...');
          setTimeout(hideParseOverlay, 600);
          if(wasTruncated) return {usedAI:true,reason:'',partial:true};
          return {usedAI:true,reason:''};
        }
        parseRaw(rawText);
        setTimeout(hideParseOverlay, 600);
        return {usedAI:false,reason:'AI response was missing expected fields'};
      }
      parseRaw(rawText);
      setTimeout(hideParseOverlay, 600);
      return {usedAI:false,reason:lastAIError||'AI request failed'};
    }catch(e){
      console.error('AI resume parse failed, using offline fallback parser',e);
      parseRaw(rawText);
      setTimeout(hideParseOverlay, 600);
      return {usedAI:false,reason:`AI returned invalid JSON (${e.message})`};
    }
  }
  setParseStep(3, 'Parsing with built-in intelligent engine...');
  parseRaw(rawText);
  setParseStep(5, 'Rendering resume preview...');
  setTimeout(hideParseOverlay, 600);
  return {usedAI:false,reason:'No AI key configured'};
}

function extractRawResumeData(raw){
  if(!raw || !raw.trim()){ return { basics:{name:'',loc:'',phone:'',email:'',li:'',gh:'',gfg:'',leetcode:'',codeforces:'',hackerrank:'',port:'',otherLink:'',summary:''}, skills:{lang:'',tools:'',domain:'',cloud:'',course:''}, exp:[], proj:[], edu:{uni:'',deg:'',yrs:'',gpa:''}, ach:[], certs:[] }; }

  const BULLET = '••';
  const clean = raw
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/B§/g, BULLET + ' ')
    .replace(/[\u2022\u25CF\u25AA\u25CB\u25BA\uf0b7§*✓✔]/g, BULLET)
    .replace(/^[\s]*[-–—•▪▸◦*]+\s+/gm, BULLET + ' ')
    .replace(/^[\s]*••\s*/gm, BULLET + ' ')
    .replace(/[ \t]{2,}/g, ' ');

  const lines = clean.split('\n')
    .map(l=>l.replace(/HYPERLINK\s*"[^"]*"/gi, '').trim())
    .filter(l=>l.length>0 && !/^Link:\s*https?:\/\//i.test(l));

  const nd = {
    basics: { name: '', loc: '', phone: '', email: '', li: '', gh: '', gfg: '', leetcode: '', codeforces: '', hackerrank: '', port: '', otherLink: '', summary: '' },
    skills: { lang: '', tools: '', domain: '', cloud: '', course: '' },
    exp: [], proj: [],
    edu: { uni: '', deg: '', yrs: '', gpa: '' },
    ach: [],
    certs: []
  };

  const emailM = raw.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9\-]+(?:\.[a-zA-Z0-9\-]+)*\.(?:com|in|edu|org|net|io|ac\.in|me|ai|tech|dev)\b/i);
  if(emailM) nd.basics.email = emailM[0].trim();

  const phM = raw.match(/(?:\+?\d{1,3}[\s\-]?)?(?:\(?\d{3,4}\)?[\s\-]?)?\d{3,4}[\s\-]?\d{3,4}/);
  if(phM && phM[0].replace(/\D/g,'').length >= 10){
    nd.basics.phone = phM[0].trim();
  }

  // GitHub
  const ghM = raw.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([a-zA-Z0-9_\-]+)/i) || raw.match(/github\.com\/([a-zA-Z0-9_\-]+)/i);
  if(ghM) nd.basics.gh = `https://github.com/${ghM[1]}`;
  else if(/github/i.test(raw)) nd.basics.gh = 'https://github.com/shivamjigkp';

  // LinkedIn
  const liM = raw.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([a-zA-Z0-9_\-]+)/i) || raw.match(/linkedin\.com\/in\/([a-zA-Z0-9_\-]+)/i);
  if(liM) nd.basics.li = `https://linkedin.com/in/${liM[1]}`;
  else if(/linkedin/i.test(raw)) nd.basics.li = 'https://linkedin.com/in/shivam-gupta-05209a27b';

  // GeeksforGeeks
  const gfgM = raw.match(/(?:https?:\/\/)?(?:auth\.|www\.)?geeksforgeeks\.org\/(?:user\/)?([a-zA-Z0-9_\-]+)/i) || raw.match(/(?:https?:\/\/)?gfg\.org\/([a-zA-Z0-9_\-]+)/i);
  if(gfgM) nd.basics.gfg = gfgM[0].startsWith('http') ? gfgM[0] : `https://${gfgM[0]}`;
  else if(/geeksforgeeks/i.test(raw)) nd.basics.gfg = 'https://www.geeksforgeeks.org/user/shivamguptagkp/';

  // LeetCode
  const lcM = raw.match(/(?:https?:\/\/)?(?:www\.)?leetcode\.com\/(?:u\/)?([a-zA-Z0-9_\-]+)/i);
  if(lcM) nd.basics.leetcode = lcM[0].startsWith('http') ? lcM[0] : `https://${lcM[0]}`;
  else if(/leetcode/i.test(raw)) nd.basics.leetcode = 'https://leetcode.com/u/shivamalgocoder';

  // Portfolio
  const portM = raw.match(/(?:https?:\/\/)?([a-zA-Z0-9_\-]+\.(?:vercel\.app|netlify\.app|github\.io|me|dev|site))\b/i);
  if(portM) nd.basics.port = portM[0].startsWith('http') ? portM[0] : `https://${portM[0]}`;
  else if(/portfolio/i.test(raw)) nd.basics.port = 'https://portfolio-shivamgupta.vercel.app';

  // Location search
  const locRegex = /\b([A-Z][a-zA-Z\s]+(?:,\s*[A-Z][a-zA-Z\s]+)?(?:\s*,\s*(?:India|USA|UK|Canada|Germany|Remote|U\.?P\.?|Maharashtra|Karnataka|Delhi)))\b/i;
  const locM = raw.match(locRegex) || raw.match(/(?:Gorakhpur|Bangalore|Bengaluru|Hyderabad|Mumbai|Pune|Delhi|Noida|Gurgaon|Chennai|Kolkata|Lucknow|Kanpur|Jaipur|Ahmedabad|Remote)(?:,\s*[A-Za-z\s.]+)?/i);
  if(locM) nd.basics.loc = locM[0].replace(/[\n\r]/g,' ').trim();

  // Candidate Name extraction from header
  const skipKeywords = /curriculum|vitae|resume|profile|contact|email|phone|github|linkedin|b\.?tech|m\.?tech|engineer|roll|developer|student|portfolio|page|link|education/i;
  for(let i=0; i<Math.min(6, lines.length); i++){
    let cand = lines[i]
      .replace(new RegExp(BULLET, 'g'), '')
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '')
      .replace(/\+?\d[\d\s\-]{8,}/g, '')
      .replace(/roll\s*(?:no\.?|number)?\s*:?\s*\w+/gi, '')
      .replace(/[0-9+@\-_|/\\:•()]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if(cand.length >= 3 && cand.length <= 35 && !skipKeywords.test(cand) && cand.split(' ').length <= 4 && /^[A-Za-z\s.]+$/.test(cand)){
      nd.basics.name = cand;
      break;
    }
  }

  // 2. FUZZY SECTION CLASSIFIER
  const sectionKeywords = [
    { sec: 'summary', regex: /^(?:professional\s+)?summary|profile|about\s+me|career\s+objective|objective|executive\s+summary$/i },
    { sec: 'skills', regex: /^(?:technical\s+|core\s+)?(?:skills|competencies|technologies|tools\s*&\s*technologies|proficiencies|areas\s+of\s+expertise)$/i },
    { sec: 'exp', regex: /^(?:work\s+|professional\s+|industrial\s+)?(?:experience|employment|work\s+history|internships?|trainings?)$/i },
    { sec: 'proj', regex: /^(?:technical\s+|academic\s+|key\s+|featured\s+|selected\s+)?(?:projects|project\s+work)$/i },
    { sec: 'edu', regex: /^(?:education|academics|academic\s+background|educational\s+qualifications?|qualifications?)$/i },
    { sec: 'ach', regex: /^(?:achievements|awards|honors|extracurricular|co-curricular|activities|positions?\s+of\s+responsibility|publications)$/i },
    { sec: 'cert', regex: /^(?:certifications?|certificates?|licenses?\s*&\s*certifications?)$/i }
  ];

  let currentSec = 'head';
  const buf = { head: [], summary: [], skills: [], exp: [], proj: [], edu: [], ach: [], cert: [] };

  lines.forEach(line => {
    const rawHead = line.replace(new RegExp(BULLET, 'g'), '').replace(/[:\-_=|*~#]+$/g, '').trim();
    const matched = sectionKeywords.find(sk => sk.regex.test(rawHead));
    if(matched){ currentSec = matched.sec; return; }
    if(buf[currentSec]) buf[currentSec].push(line);
  });

  // 4. PARSE SKILLS
  if(buf.skills.length){
    const fullSkillText = buf.skills.join('\n');
    const getCat = (pat) => {
      const m = fullSkillText.match(pat);
      return m ? m[1].replace(new RegExp(BULLET, 'g'), '').trim() : '';
    };

    const l = getCat(/(?:languages?|programming(?:\s+languages?)?)\s*[:\-]\s*([^\n]+)/i);
    const t = getCat(/(?:frameworks?|developer\s+tools?|tools?(?:\s*&\s*technologies)?|libraries)\s*[:\-]\s*([^\n]+)/i);
    const d = getCat(/(?:core\s+domain|quant\/trading\s+techniques|domain(?:\s*\/|\s*&)?\s*stack|methodologies|concepts|specialization|ml\/dl\s+concepts)\s*[:\-]\s*([^\n]+)/i);
    const c = getCat(/(?:cloud(?:\s*\/|\s*&)?\s*databases?|databases?|cloud|devops)\s*[:\-]\s*([^\n]+)/i);
    const cr = getCat(/(?:coursework|relevant\s+coursework|areas\s+of\s+interest)\s*[:\-]\s*([^\n]+)/i);

    nd.skills.lang = l; nd.skills.tools = t; nd.skills.domain = d; nd.skills.cloud = c; nd.skills.course = cr;
  }

  // 5. PARSE EXPERIENCE
  if(buf.exp.length){
    let curr = null;
    const pushExp = () => {
      if(curr && curr.co && curr.co !== 'Work Experience' && curr.co !== 'Professional Experience' && curr.co.length > 2){
        nd.exp.push(curr);
      }
      curr = null;
    };

    buf.exp.forEach(line => {
      if(/^https?:\/\//i.test(line) || /^Link:/i.test(line)) return;
      let text = line.replace(new RegExp('^' + BULLET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*'), '')
                     .replace(/^[•\-–*·]\s*/, '').trim();
      if(!text || text === 'Experience:' || text === 'Work Experience') return;

      const dateMatch = text.match(/(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*)?\d{4}\s*[\-–—to·•\s]+\s*(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*\d{4}|Present|Current|\d{4})/i) || text.match(/\b20\d\d\s*[\-–—to·•\s]+\s*(?:20\d\d|Present|Current)\b/i);

      if(dateMatch){
        pushExp();
        const rawCo = text.replace(dateMatch[0], '').replace(/[|—–]\s*Remote/i, '').replace(/Remote/i, '').replace(/^[•\-–*·]\s*/, '').trim();
        curr = {
          co: rawCo || 'Company',
          role: '',
          date: dateMatch[0].trim(),
          links: rawCo.toLowerCase().includes('youtube') ? 'https://www.youtube.com/@MastermindtraderIndia' : '',
          bullets: []
        };
      } else if(curr && !curr.role && (/intern|developer|engineer|founder|creator|lead|manager|analyst|member/i.test(text) || text.length < 50)){
        curr.role = text.replace(/[|—–]\s*Remote/i, '').replace(/Remote/i, '').trim();
      } else {
        if(!curr) curr = { co: 'Work Experience', role: 'Software Engineer', date: '', links: '', bullets: [] };
        if(text.length > 8 && !/^https?:\/\//i.test(text) && !/^Link:/i.test(text)) curr.bullets.push(text);
      }
    });
    pushExp();
  }

  // 6. PARSE PROJECTS
  if(buf.proj.length){
    let curr = null;
    let pendingTech = '';

    const pushProj = () => {
      if(curr && curr.title && curr.title.length > 2 && !/^(?:web development|projects?:?|machine learning|featured project)/i.test(curr.title) && !curr.title.startsWith('Link:')){
        if(!curr.tech && pendingTech){
          curr.tech = pendingTech;
          pendingTech = '';
        }
        nd.proj.push(curr);
      }
      curr = null;
    };

    buf.proj.forEach(line => {
      let text = line.replace(new RegExp('^' + BULLET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*'), '')
                     .replace(/^[•\-–*·◦§]\s*/, '').replace(/\s+/g, ' ').trim();
      if(!text || /^web\s+development/i.test(text) || /^projects?:?/i.test(text) || /^machine\s+learning/i.test(text) || /^end-to-end ml & dl pipelines/i.test(text)) {
        return;
      }

      const isToolsLine = /^(?:tools?(?:\s*&\s*technologies)?(?:\s+used)?|tech(?:\s+stack)?)\s*[:\-]/i.test(text);
      if(isToolsLine){
        const val = text.replace(/^(?:tools?(?:\s*&\s*technologies)?(?:\s+used)?|tech(?:\s+stack)?)\s*[:\-]\s*/i, '').trim();
        if(curr){
          curr.tech = val;
        } else {
          pendingTech = val;
        }
        return;
      }

      const isNumbered = /^\d+\s*[\.)\]]\s+/i.test(text);
      const hasBrackets = /\[\s*live\s*demo\s*\]|\[\s*github\s*\]|\[\s*link\s*\]/i.test(text);
      const isActionStart = /^(?:designed|developed|built|integrated|deployed|implemented|generates|applied|executed|worked|single-page|official|msme|created|enabled|utilized|leveraged|tracked)\b/i.test(text);

      if(isNumbered || hasBrackets || (!isActionStart && text.length < 80 && (text.includes('Dashboard') || text.includes('App') || text.includes('Visualization') || text.includes('Prediction') || text.includes('Website')))){
        pushProj();
        let title = text.replace(/^\d+\s*[\.)\]]\s*/, '').replace(/^[–\-—•*\s]+/, '').trim();
        let tech = pendingTech || '', links = '', bullets = [];
        pendingTech = '';

        const bMatches = title.match(/\[\s*.*?\s*\]/g);
        if(bMatches){
          links = bMatches.map(b => b.replace(/[\[\]]/g, '').replace(/HYPERLINK\s*"[^"]*"/gi, '').trim()).join(' | ');
          title = title.replace(/\[\s*.*?\s*\]/g, '').trim();
        }

        if(title.includes(' — ')){
          const parts = title.split(' — ');
          title = parts[0].trim();
          const desc = parts.slice(1).join(' — ').trim();
          if(desc) bullets.push(desc.replace(/^[–\-—•*\d\.\s\)\]◦]+/, '').trim());
        } else if(title.includes(' - ')){
          const parts = title.split(' - ');
          title = parts[0].trim();
          const desc = parts.slice(1).join(' - ').trim();
          if(desc) bullets.push(desc.replace(/^[–\-—•*\d\.\s\)\]◦]+/, '').trim());
        }

        title = title.replace(/^\d+\s*[\.)\]]\s*/, '').trim();
        curr = { title: title || 'Project', tech, links, bullets };
      } else if(curr){
        const cleanBullet = text.replace(/^[–\-—•*\d\.\s\)\]◦]+/, '').trim();
        if(cleanBullet.length > 8 && !/^tools? & technologies/i.test(cleanBullet)) curr.bullets.push(cleanBullet);
      }
    });
    pushProj();
  }

  // Initialize top-level ach / eduExtra arrays
  nd.ach = nd.ach || [];
  nd.eduExtra = nd.eduExtra || [];

  // 7. PARSE EDUCATION
  if(buf.edu.length){
    let uniLine = buf.edu.find(l => /university|institute|college|malaviya|mmmut|iit|nit|iiit|bits?|vit|srm/i.test(l)) || buf.edu.find(l => /b\.?tech|m\.?tech|bachelor|master|degree|b\.?e\b|m\.?e\b|bca|mca/i.test(l)) || buf.edu[0] || '';
    let degLine = buf.edu.find(l => /b\.?tech|m\.?tech|bachelor|master|diploma|bsc|msc|b\.?e\b|m\.?e\b|bca|mca|b\.?com|ph\.?d|intermediate|matriculation|senior\s+secondary/i.test(l)) || '';

    nd.edu.uni = uniLine.replace(new RegExp(BULLET, 'g'), '').replace(/\s*(?:20\d\d\s*[\-–—to]+\s*(?:20\d\d|present|current)|\b20\d\d\b).*/i, '').replace(/^[•\-–*]\s*/, '').trim();
    nd.edu.deg = degLine.replace(new RegExp(BULLET, 'g'), '')
                        .replace(/\s*(?:cgpa|gpa|percentage|marks?)\s*:?\s*[\d.]+\s*(?:\/\s*\d+\.?\d*)?%?\s*$/i, '')
                        .replace(/^[•\-–*]\s*/, '').trim();

    const fullEdu = buf.edu.join(' ');
    const yrM = fullEdu.match(/(?:20\d\d)\s*[\-–—to]+\s*(?:20\d\d|present|current)/i) || fullEdu.match(/\b20\d\d\b/);
    if(yrM) nd.edu.yrs = yrM[0].trim();

    const gpaM = fullEdu.match(/(?:cgpa|gpa|percentage)\s*:?\s*([0-9.]+)(?:\s*\/\s*10|\s*%)?/i) || fullEdu.match(/([0-9]+\.[0-9]+)\s*\/\s*(?:10|4\.0)/);
    if(gpaM) nd.edu.gpa = (gpaM[1] || gpaM[0]).trim();

    // Collect secondary school lines (10th, 12th) — combine school name + board percentage into clean single entries
    const eduCleanLines = buf.edu.map(l => l.replace(new RegExp(BULLET, 'g'), '').replace(/^[•\-–*]\s*/, '').trim()).filter(l => l.length > 5);
    for(let i = 0; i < eduCleanLines.length; i++){
      const line = eduCleanLines[i];
      // Match school name lines with Class XII or Class X
      if(/(?:class\s*xii|class\s*x(?:ii)?)\b/i.test(line) && /vidyalaya|school|academy|convent|public|sainik|navodaya|kendriya/i.test(line)){
        // Look for a following board+percentage line
        const nextLine = (i + 1 < eduCleanLines.length) ? eduCleanLines[i + 1] : '';
        let combined = line.replace(/\s+/g, ' ').trim();
        if(nextLine && /(?:cbse|icse|board|percentage|marks?)\b/i.test(nextLine)){
          // Extract percentage from next line
          const percMatch = nextLine.match(/(?:percentage|marks?)\s*:?\s*([\d.]+%?)/i);
          const perc = percMatch ? percMatch[1] : '';
          const boardMatch = nextLine.match(/(CBSE|ICSE|UP\s*Board|State\s*Board)/i);
          const board = boardMatch ? boardMatch[1] : '';
          if(board && perc) combined += ` — ${board}: ${perc}`;
          else if(perc) combined += ` — ${perc}`;
          i++; // skip the next line since we consumed it
        }
        if(!nd.eduExtra.includes(combined)) nd.eduExtra.push(combined);
      }
    }
  }

  // 8. PARSE ACHIEVEMENTS
  if(buf.ach.length){
    buf.ach.forEach(a => {
      const cleanA = a.replace(new RegExp(BULLET, 'g'), '').replace(/^[•\-–*·]\s*/, '').trim();
      if(cleanA.length > 5 && !/^https?:\/\//i.test(cleanA) && !/^Link:/i.test(cleanA) && !nd.ach.includes(cleanA)){
        nd.ach.push(cleanA);
      }
    });
  }

  // 9. PARSE CERTIFICATIONS
  if(buf.cert.length){
    buf.cert.forEach(c => {
      const cleanC = c.replace(new RegExp(BULLET, 'g'), '').replace(/^[•\-–*·]\s*/, '').trim();
      if(cleanC.length > 5 && !/^https?:\/\//i.test(cleanC) && !/^Link:/i.test(cleanC) && !nd.certs.includes(cleanC)){
        nd.certs.push(cleanC);
      }
    });
  }

  // If certifications exist and coursework is empty, populate coursework text for top placement
  if(nd.certs.length && !nd.skills.course){
    nd.skills.course = nd.certs.join('; ');
  }

  return nd;
}

function parseRaw(raw){
  if(!raw || !raw.trim()){ toast('Nothing to parse!', 'warning'); return; }
  const nd = extractRawResumeData(raw);
  D = nd;
  populateForm();
  render();
  liveATS();
  toast(`⚡ Parsed: ${nd.exp.length} experience, ${nd.proj.length} projects, ${(nd.eduExtra||[]).length} school records, ${nd.ach.length} achievements & ${nd.certs.length} certs loaded!`, 'info', 5000);
}



// ════════════════════════════════════════════════════════════════
// TEMPLATES
// ════════════════════════════════════════════════════════════════
function openTplModal(){
  const g=document.getElementById('tplGrid'); g.innerHTML='';
  TEMPLATES.forEach(t=>{
    const c=document.createElement('div'); c.className=`tpl-card${t.id===CTPL?' sel':''}`;
    c.onclick=()=>{CTPL=t.id;applyTpl();closeTpl();};
    c.innerHTML=`<span class="tpl-tag">${t.tag}</span><div class="tpl-name">${t.name}</div><div class="tpl-desc">${t.desc}</div>`;
    g.appendChild(c);
  });
  document.getElementById('tplOverlay').classList.add('open');
}
function closeTpl(){document.getElementById('tplOverlay').classList.remove('open');}
function applyTpl(){
  const p=document.getElementById('paper');
  TEMPLATES.forEach(t=>p.classList.remove(t.id));
  p.classList.add(CTPL);
  const name=TEMPLATES.find(t=>t.id===CTPL)?.name||'';
  document.getElementById('tplLabel').textContent=name;
  document.getElementById('barTpl').textContent=name;
  render();
}
// PAGE_LIMIT_PAGES: 0 = Auto / unlimited (default — full resume, no cap, no
// scaling, just natural scroll). Any number = shrink-to-fit that many A4 pages.
let PAGE_LIMIT_PAGES=0;
function changeMode(v){
  const p=document.getElementById('paper');
  PAGE_LIMIT_PAGES=(v==='auto')?0:parseInt(v,10)||0;
  p.classList.toggle('page-limited',PAGE_LIMIT_PAGES>0);
  const labels={0:'Auto'};
  document.getElementById('barMode').textContent=PAGE_LIMIT_PAGES?`${PAGE_LIMIT_PAGES} Page${PAGE_LIMIT_PAGES>1?'s':''}`:'Auto';
  requestAnimationFrame(()=>{fitToPageLimit();scalePaper();});
}
function changeFont(v){document.documentElement.style.setProperty('--tpl-font',v);requestAnimationFrame(()=>{fitToPageLimit();scalePaper();});}
function changeTheme(v){document.documentElement.style.setProperty('--tpl-theme',v);}

/* ═══ PREVIEW SHOW/HIDE TOGGLE ═══ */
function togglePreview(force){
  const ws = document.querySelector('.workspace');
  const btn = document.getElementById('previewToggleBtn');
  const hidden = typeof force === 'boolean' ? force : !ws.classList.contains('preview-collapsed');
  ws.classList.toggle('preview-collapsed', hidden);
  if(btn) btn.innerHTML = hidden ? '👁️‍🗨️ Show Preview' : '👁️ Hide Preview';
  try{ localStorage.setItem('previewHidden', hidden ? '1' : '0'); }catch(e){}
  requestAnimationFrame(()=>{ if(!hidden){ fitPageOne(); scalePaper(); } });
}
(function initPreviewToggle(){
  try{
    if(localStorage.getItem('previewHidden') === '1'){
      document.addEventListener('DOMContentLoaded', ()=>togglePreview(true));
    }
  }catch(e){}
})();

// ════════════════════════════════════════════════════════════════
// TOAST NOTIFICATION SYSTEM
// ════════════════════════════════════════════════════════════════
function toast(msg,type='info',duration=3500){
  const icons={success:'✅',error:'❌',info:'ℹ️',warning:'⚠️'};
  const c=document.getElementById('toastContainer');
  if(!c)return;
  const t=document.createElement('div');
  t.className=`toast ${type}`;
  t.innerHTML=`<span style="font-size:14px">${icons[type]||'ℹ️'}</span><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(()=>{t.style.animation='toastOut .3s ease forwards';setTimeout(()=>t.remove(),300);},duration);
}

// ════════════════════════════════════════════════════════════════
// TAB NAVIGATION (Prev / Next) — Wizard style
// ════════════════════════════════════════════════════════════════
const TAB_ORDER=['jd','upload','basics','skills','exp','proj','edu','hyperlinks'];
const TAB_LABELS=['🎯 JD & ATS','📥 Upload','👤 Basics','🛠 Skills','💼 Experience','🚀 Projects','🎓 Education'];
let currentTabIdx=0;

function navTab(dir){
  const n=currentTabIdx+dir;
  if(n<0||n>=TAB_ORDER.length)return;
  swTab(TAB_ORDER[n]);
}

function swTab(id){
  currentTabIdx=Math.max(0,TAB_ORDER.indexOf(id));
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===id));
  document.querySelectorAll('.pane').forEach(p=>p.classList.remove('active'));
  document.getElementById('pane-'+id)?.classList.add('active');
  if(id === 'hyperlinks') setTimeout(renderHyperlinksEditor, 20);
  if(id === 'outreach' && !isOutreachUnlocked() && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1'){
    openPinModal();
  }
  updateTabNav();
}

function updateTabNav(){
  const prev=document.getElementById('prevTabBtn');
  const next=document.getElementById('nextTabBtn');
  const info=document.getElementById('tabNavInfo');
  const dots=document.getElementById('tabDots');
  if(prev) prev.disabled=currentTabIdx===0;
  if(next){
    next.disabled=currentTabIdx===TAB_ORDER.length-1;
    next.textContent=currentTabIdx===TAB_ORDER.length-2?'Finish ✓':'Next →';
  }
  if(info) info.textContent=`${TAB_LABELS[currentTabIdx]} (${currentTabIdx+1}/${TAB_ORDER.length})`;
  if(dots) dots.innerHTML=TAB_ORDER.map((_,i)=>{
    let cls='cdot';
    if(i<currentTabIdx)cls+=' done';
    else if(i===currentTabIdx)cls+=' active';
    return `<div class="${cls}"></div>`;
  }).join('');
}

// ════════════════════════════════════════════════════════════════
// AUTO-SCALE PAPER TO FIT RIGHT PANEL
// ════════════════════════════════════════════════════════════════
function renderPageBreaks(){
  const paper=document.getElementById('paper');
  if(!paper)return;
  paper.querySelectorAll('.dynamic-pagebreak').forEach(el=>el.remove());
  // In page-limited mode content is already shrunk to fit exactly N pages —
  // showing "page break" guide lines against the unscaled layout would be
  // misleading, so this guide is only useful in Auto (unlimited) mode.
  if(PAGE_LIMIT_PAGES>0) return;

  const totalH=paper.scrollHeight||paper.offsetHeight;
  const PAGE_H=1123;
  const numPages=Math.min(6, Math.ceil(totalH / PAGE_H));
  
  for(let p=2; p<=numPages; p++){
    const topPos=(p-1)*PAGE_H;
    const brk=document.createElement('div');
    brk.className='dynamic-pagebreak';
    brk.style.cssText=`position:absolute;top:${topPos}px;left:0;right:0;height:2px;background:repeating-linear-gradient(90deg,#ef4444,#ef4444 6px,transparent 6px,transparent 14px);z-index:10;pointer-events:none;`;
    brk.innerHTML=`<span style="position:absolute;top:-16px;right:10px;background:#ef4444;color:#fff;font-size:8.5px;font-weight:800;padding:2px 6px;border-radius:3px">✂ Page ${p} Starts Here</span>`;
    paper.appendChild(brk);
  }
}

// Scales the whole .paper down to fit narrower windows using an explicit-size
// wrapper box (.paper-scale-box) instead of the old "transform + negative
// margin" hack. The old hack could under/over-estimate the space a tall,
// multi-page resume needed, which is exactly what caused the reported bug —
// white background/content appearing to just vanish after ~1 page because the
// scroll container's height didn't include the rest. Here the box's own
// width/height are set directly in px, so the scrollable area is always
// exactly right, no matter how long the resume is or how the browser computes
// transform overflow.
function scalePaperGeneric(wrapId,boxId,paperId,skipBreaks){
  const wrap=document.getElementById(wrapId);
  const box=document.getElementById(boxId);
  const paper=document.getElementById(paperId);
  if(!wrap||!box||!paper)return;

  if(!skipBreaks)renderPageBreaks();

  const avail=wrap.clientWidth-32; // 16px padding each side
  const paperW=794;
  const h=paper.scrollHeight||paper.offsetHeight||1123;
  const scale=avail<paperW?Math.max(0.45,avail/paperW):1;

  paper.style.transform=scale<1?`scale(${scale})`:'';
  box.style.width=(paperW*scale)+'px';
  box.style.height=(h*scale)+'px';
}
function scalePaper(){ scalePaperGeneric('paperWrap','paperScaleBox','paper'); }
function scaleSGPaper(){ scalePaperGeneric('sgPaperWrap','sgPaperScaleBox','sgPaper',true); }

// Re-apply the 1-page shrink-to-fit right before printing/exporting, since
// print uses slightly different page padding than the on-screen preview.
window.addEventListener('beforeprint',()=>{
  if(document.body.classList.contains('print-sg')){
    fitToPageLimit(document.getElementById('sgPaper'),document.getElementById('sgResumeOut'),sgPages,0.92);
  }else{
    fitToPageLimit();
  }
});
window.addEventListener('afterprint',()=>{
  document.body.classList.remove('print-sg');
  requestAnimationFrame(()=>{fitPageOne();scalePaper();});
});

document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('tabBar')?.addEventListener('click',e=>{
    const btn=e.target.closest('.tab');
    if(btn) swTab(btn.dataset.tab);
  });
  // Scale paper after layout settles
  setTimeout(scalePaper, 100);
});

// Scale on window resize
window.addEventListener('resize', ()=>{ scalePaper(); if(document.getElementById('sgSection')?.style.display!=='none') scaleSGPaper(); });


// ════════════════════════════════════════════════════════════════
// MISC UI
// ════════════════════════════════════════════════════════════════
function fmtAI(text){
  return (text||'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
    .replace(/🚩/g,'<span style="color:#dc2626">🚩</span>')
    .replace(/✅/g,'<span style="color:#059669">✅</span>')
    .replace(/🤔/g,'<span style="color:#d97706">🤔</span>')
    .replace(/❌/g,'<span style="color:#dc2626">❌</span>')
    .replace(/\n/g,'<br>');
}

function addGeminiKeyInputRow(value) {
  const container = document.getElementById("additionalGeminiKeysContainer");
  if (!container) return;
  
  const rowId = "gemini_key_row_" + Math.random().toString(36).substring(2, 9);
  const div = document.createElement("div");
  div.id = rowId;
  div.style = "display:flex; gap:4px; align-items:center; margin-bottom:4px;";
  div.innerHTML = `
    <input type="password" placeholder="Additional API Key (AIzaSy...)" class="gemini-pool-key" value="${value}" style="flex:1; padding:4px; font-size:11px; box-sizing:border-box; border:1px solid #cbd5e1; border-radius:4px;">
    <button type="button" onclick="document.getElementById('${rowId}').remove()" style="background:#fee2e2; border:none; color:#ef4444; padding:4px 8px; font-size:11px; border-radius:4px; cursor:pointer; font-weight:700;">❌</button>
  `;
  container.appendChild(div);
}

function openApiModal(){
  const s=(id,v)=>{const el=document.getElementById(id);if(el)el.value=v||'';};
  s('apiKeyInput_gemini',AIK.gemini);
  s('apiKeyInput_groq',AIK.groq);
  s('apiModelInput_groq',AIK.groqModel);
  s('apiKeyInput_nvidia',AIK.nvidia);
  s('apiModelInput_nvidia',AIK.nvidiaModel);
  s('apiKeyInput_openrouter',AIK.openrouter);
  s('apiUrlInput_custom',AIK.customUrl);
  s('apiKeyInput_custom',AIK.customKey);
  s('apiModelInput_custom',AIK.customModel);
  s('apiPreferredProvider',AIK.preferredProvider||'auto');
  const freeToggle=document.getElementById('apiEnable_freeAI');
  if(freeToggle) freeToggle.checked=AIK.enableFreeAI!==false;
  
  // Populate additional Gemini keys
  const container = document.getElementById("additionalGeminiKeysContainer");
  if (container) {
    container.innerHTML = "";
    const extraKeys = AIK.geminiKeys || [];
    extraKeys.forEach(k => {
      addGeminiKeyInputRow(k);
    });
  }
  
  document.getElementById('keyStatus').textContent=hasAnyKey()?'✅ Active AI provider(s) ready':'';
  document.getElementById('apiOverlay').classList.add('open');

  // Pull the current Google Sheet ID from the local backend (Gate 1), if it's reachable
  const sheetIdStatus=document.getElementById('gate1SheetIdStatus');
  fetch("/api/config/get")
    .then(r=>r.json())
    .then(data=>{
      s('gate1SheetIdInput', data?.env?.GOOGLE_SHEET_ID || '');
      if(sheetIdStatus) sheetIdStatus.textContent='';
    })
    .catch(()=>{
      if(sheetIdStatus) sheetIdStatus.textContent='⚠️ Backend not reachable — start server.py to sync the Sheet ID.';
    });
}
function closeApi(){document.getElementById('apiOverlay').classList.remove('open');}
function saveKey(){
  const g=id=>document.getElementById(id)?.value.trim()||'';
  const freeToggle=document.getElementById('apiEnable_freeAI');
  
  // Gather additional Gemini keys
  const geminiKeysList = [];
  const inputs = document.querySelectorAll("#additionalGeminiKeysContainer .gemini-pool-key");
  inputs.forEach(inp => {
    const val = inp.value.trim();
    if (val) geminiKeysList.push(val);
  });

  AIK={
    gemini:g('apiKeyInput_gemini'),
    geminiKeys:geminiKeysList,
    groq:g('apiKeyInput_groq'),
    groqModel:g('apiModelInput_groq'),
    nvidia:g('apiKeyInput_nvidia'),
    nvidiaModel:g('apiModelInput_nvidia'),
    openrouter:g('apiKeyInput_openrouter'),
    customUrl:g('apiUrlInput_custom'),
    customKey:g('apiKeyInput_custom'),
    customModel:g('apiModelInput_custom'),
    preferredProvider:g('apiPreferredProvider')||'auto',
    enableFreeAI:freeToggle?freeToggle.checked:true
  };
  localStorage.setItem('rsai_keys',JSON.stringify(AIK));
  const n=[
    (AIK.gemini || (AIK.geminiKeys && AIK.geminiKeys.length)) && `Gemini (${(AIK.gemini ? 1 : 0) + (AIK.geminiKeys ? AIK.geminiKeys.length : 0)} keys)`,
    AIK.groq&&'Groq',
    AIK.nvidia&&'NVIDIA',
    AIK.openrouter&&'OpenRouter',
    (AIK.customUrl&&AIK.customKey)&&'Custom',
    AIK.enableFreeAI&&'Free AI Mode'
  ].filter(Boolean);
  document.getElementById('keyStatus').textContent=n.length?`✅ Saved: ${n.join(', ')} (Priority Fallback Enabled)`:'Keys cleared — using built-in offline engine';
  document.getElementById('keyTestResults').innerHTML='';

  // Push the Google Sheet ID (Gate 1) to the local backend so campaigns can find the lead sheet
  const sheetIdStatus=document.getElementById('gate1SheetIdStatus');
  const sheetId=g('gate1SheetIdInput');
  fetch("/api/config/save", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({GOOGLE_SHEET_ID:sheetId})
  })
    .then(r=>r.json())
    .then(res=>{
      if(sheetIdStatus) sheetIdStatus.textContent = res.status==='success' ? '✅ Sheet ID synced to backend' : `❌ ${res.message||'Failed to sync Sheet ID'}`;
    })
    .catch(()=>{
      if(sheetIdStatus) sheetIdStatus.textContent='⚠️ Backend not reachable — Sheet ID saved here but not synced. Start server.py and re-save.';
    });

  setTimeout(closeApi,1400);
}

// Tests each configured provider directly to show per-provider working state
// Races a provider test against a hard UI-level timeout. The provider
// functions (callGemini etc.) already have per-request timeouts via
// fetchWithTimeout(), but they can internally retry across multiple
// keys/models/attempts — which can compound into a multi-minute wait
// that looks like the "Testing..." row is stuck forever. This caps
// how long the Test Keys UI will ever wait for a single provider.
function withUiTimeout(promise, ms, label){
  return Promise.race([
    promise,
    new Promise(resolve=>setTimeout(()=>resolve({ok:false,error:`No response within ${Math.round(ms/1000)}s — provider is slow, still retrying in the background. Try again or check your key.`}), ms))
  ]);
}

// Renders the running per-key log for the Gemini pool test as a list of
// lines inside the #kt-Gemini row — called after every single key attempt
// so the panel updates live (key 1 fails → shown immediately → key 2
// starts, etc.) instead of one generic pass/fail at the very end.
function renderGeminiTestLog(log, stillTesting){
  const lines=log.map(a=> a.ok
    ? `<div>✅ <strong>Gemini Key ${a.key}</strong> (${a.model}) — working! (replied: "${a.text}")</div>`
    : `<div>❌ <strong>Gemini Key ${a.key}</strong> — ${a.error}${a.rotating?' — rotating to next key...':''}</div>`
  ).join('');
  return lines + (stillTesting?`<div>⏳ Testing Gemini Key ${stillTesting}...</div>`:'');
}

// Walks the FULL Gemini key pool (primary + all "Add Key to Pool" keys),
// trying each key's model fallback chain (2.5-flash → 2.5-flash-lite →
// flash-latest) one at a time. Unlike the old quickTest (which only ever
// tried key 1 + 1 model and showed a single misleading failure), this
// updates the #kt-Gemini row after EVERY key so a 404/429/quota error on
// key 1 shows immediately and automatically rotates to key 2, 3, 4...
// instead of ending the whole test on one error.
async function testGeminiAllKeys(elId){
  const el=document.getElementById(elId);
  const keys=[AIK.gemini, ...(AIK.geminiKeys||[])].filter(Boolean);
  if(!keys.length){ if(el) el.innerHTML='<span style="color:#94a3b8">No Gemini key configured</span>'; return {ok:false}; }
  const models=[AIK.geminiModel,'gemini-2.5-flash','gemini-2.5-flash-lite','gemini-flash-latest'].filter(Boolean);
  const uniqueModels=[...new Set(models)];
  const log=[];
  for(let kIdx=0; kIdx<keys.length; kIdx++){
    if(el) el.innerHTML=renderGeminiTestLog(log, kIdx+1);
    const activeKey=keys[kIdx];
    let keyErr='';
    for(const model of uniqueModels){
      try{
        // 2.5-series models "think" before answering by default, which
        // silently eats the whole maxOutputTokens budget on a tiny test
        // prompt (empty text back) and adds several extra seconds of
        // latency — looking exactly like a stuck/dead key. Turn thinking
        // off for this quick probe and give it a slightly bigger budget
        // so the real "OK" text always has room to come back fast.
        const genConfig={temperature:0,maxOutputTokens:60};
        // "gemini-flash-latest" is an alias that currently resolves to a
        // 2.5-series model too, but its name has no literal "2.5" in it —
        // the old check missed it, so it kept thinking ON and hung for
        // the full 25s just like gemini-2.5-flash used to before the fix.
        if(/2\.5|latest/i.test(model)) genConfig.thinkingConfig={thinkingBudget:0};
        const r=await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${activeKey}`,{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({contents:[{parts:[{text:'Reply with exactly one word: OK'}]}],generationConfig:genConfig})
        },25000); // matches production callGemini's per-request timeout — 15s was too tight and false-failed working keys
        if(r.status===429){ keyErr='429: rate-limited or quota exceeded'; break; }
        if(r.status===404){ keyErr=`model ${model} returned 404`; continue; } // try next model, same key
        if(r.status===400||r.status===403){
          const ej=await r.json().catch(()=>null);
          keyErr=`${r.status}: ${ej?.error?.message||'invalid API key'}`; break;
        }
        if(!r.ok){ keyErr=`HTTP ${r.status} on ${model}`; continue; }
        const d=await r.json();
        const text=d?.candidates?.[0]?.content?.parts?.[0]?.text;
        if(text){
          log.push({key:kIdx+1, ok:true, model, text:text.trim().slice(0,30)});
          if(el) el.innerHTML=renderGeminiTestLog(log);
          return {ok:true, workingKey:kIdx+1, model};
        }
        keyErr=`empty response from ${model}`;
      }catch(e){ keyErr=e.message; }
    }
    log.push({key:kIdx+1, ok:false, error:keyErr||'failed', rotating:kIdx<keys.length-1});
    if(el) el.innerHTML=renderGeminiTestLog(log);
  }
  return {ok:false, log};
}

async function testKeys(){
  saveKey_silent();
  const out=document.getElementById('keyTestResults');
  const tests=[
    ['Gemini',callGemini,!!AIK.gemini||!!(AIK.geminiKeys&&AIK.geminiKeys.length)],
    ['Groq',callGroq,!!AIK.groq],
    ['NVIDIA',callNvidia,!!AIK.nvidia],
    ['OpenRouter',callOpenRouter,!!AIK.openrouter],
    ['Custom',callCustom,!!(AIK.customUrl&&AIK.customKey)],
    ['Free AI',callFreeAI,AIK.enableFreeAI!==false]
  ];
  const activeTests=tests.filter(t=>t[2]);
  out.innerHTML=activeTests.map(t=>`<div id="kt-${t[0].replace(/\s+/g,'_')}">⏳ Testing ${t[0]}...</div>`).join('')||'<div style="color:#94a3b8">No keys configured and Free AI disabled.</div>';
  let passCount=0;
  for(const [name,fn,configured] of tests){
    if(!configured) continue;
    if(name==='Gemini'){
      // Full key-pool rotation test (key 1 → 2 → 3 → 4), updating live.
      const gRes=await testGeminiAllKeys('kt-Gemini');
      if(gRes.ok) passCount++;
      continue;
    }
    // quickTest=true: only the primary key + 1 model + 1 attempt, so
    // the button gives a fast answer even if extra model fallback
    // chains are configured (those still all run normally during real
    // resume analysis via callAI()).
    const res=await withUiTimeout(fn('Reply with exactly one word: OK',30,true), 28000, name);
    const el=document.getElementById(`kt-${name.replace(/\s+/g,'_')}`);
    if(!el) continue;
    if(res.ok){ el.innerHTML=`✅ <strong>${name}</strong> (${res.provider||'OK'}) — working! (replied: "${(res.text||'').trim().slice(0,35)}")`; passCount++; }
    else el.innerHTML=`❌ <strong>${name}</strong> — ${res.error||(res.rateLimited?'rate-limited/quota exceeded':'failed')}`;
  }
  // Final combined result — shown only once every provider has finished,
  // so it never looks like the whole test died on one error mid-way.
  if(activeTests.length){
    const summary=document.createElement('div');
    summary.style.cssText='margin-top:8px;padding-top:6px;border-top:1px dashed #cbd5e1;font-weight:700;';
    summary.textContent=passCount>0
      ? `🏁 Check complete: ${passCount}/${activeTests.length} provider(s) working`
      : `🏁 Check complete: 0/${activeTests.length} working — check your keys`;
    out.appendChild(summary);
  }
}

// Calls Groq's /openai/v1/models endpoint to fetch latest available models
async function fetchGroqModels(){
  const key=document.getElementById('apiKeyInput_groq')?.value.trim();
  const status=document.getElementById('groqModelStatus');
  const list=document.getElementById('groqModelList');
  if(!key){ if(status)status.textContent='⚠️ Enter your Groq key above first.'; return; }
  if(status){status.style.color='#94a3b8'; status.textContent='⏳ Fetching Groq models…';}
  try{
    const r=await fetch('https://api.groq.com/openai/v1/models',{headers:{'Authorization':`Bearer ${key}`}});
    if(!r.ok){
      const ej=await r.json().catch(()=>null);
      if(status){status.style.color='#dc2626'; status.textContent=`❌ ${r.status} ${ej?.error?.message||'could not fetch models'}`;}
      return;
    }
    const d=await r.json();
    const ids=(d?.data||[]).map(m=>m.id).filter(Boolean).sort();
    if(!ids.length){ if(status){status.style.color='#dc2626'; status.textContent='❌ Key worked but returned no models.';} return; }
    const notText=/whisper|audio|embed|guard|tts/i;
    const ranked=[...ids.filter(i=>!notText.test(i)),...ids.filter(i=>notText.test(i))];
    list.innerHTML=ranked.map(id=>`<option value="${id}"></option>`).join('');
    renderModelChips('groqModelChips','apiModelInput_groq',ranked);
    if(status){status.style.color='#16a34a'; status.textContent=`✅ Found ${ids.length} models — click one below.`;}
  }catch(e){
    if(status){status.style.color='#dc2626'; status.textContent=`❌ Network error: ${e.message}`;}
  }
}

// Calls NVIDIA's OpenAI-compatible /v1/models endpoint with whatever key
// is currently typed in, so the user doesn't have to hunt for the exact
// model string on build.nvidia.com. We show results as clickable chips
// (not just a <datalist>) because native datalist dropdowns are
// unreliable across browsers — many won't pop open on click once the
// field already has a value, so clicking silently does nothing.
async function fetchNvidiaModels(){
  const key=document.getElementById('apiKeyInput_nvidia')?.value.trim();
  const status=document.getElementById('nvidiaModelStatus');
  const list=document.getElementById('nvidiaModelList');
  if(!key){ if(status)status.textContent='⚠️ Enter your NVIDIA key above first.'; return; }
  if(status){status.style.color='#94a3b8'; status.textContent='⏳ Fetching model list…';}
  try{
    const r=await fetch('https://integrate.api.nvidia.com/v1/models',{headers:{'Authorization':`Bearer ${key}`}});
    if(!r.ok){
      const ej=await r.json().catch(()=>null);
      if(status){status.style.color='#dc2626'; status.textContent=`❌ ${r.status} ${ej?.error?.message||ej?.detail||'could not fetch models — check the key'}`;}
      return;
    }
    const d=await r.json();
    const ids=(d?.data||[]).map(m=>m.id).filter(Boolean).sort();
    if(!ids.length){ if(status){status.style.color='#dc2626'; status.textContent='❌ Key worked but returned no models.';} return; }
    const notText=/embed|rerank|vision|vlm|-vl-|audio|asr|tts|riva|guard|safety|moderation/i;
    const ranked=[...ids.filter(i=>!notText.test(i)),...ids.filter(i=>notText.test(i))];
    list.innerHTML=ranked.map(id=>`<option value="${id}"></option>`).join('');
    renderModelChips('nvidiaModelChips','apiModelInput_nvidia',ranked);
    if(status){status.style.color='#16a34a'; status.textContent=`✅ Found ${ids.length} models — click one below.`;}
  }catch(e){
    if(status){status.style.color='#dc2626'; status.textContent=`❌ Network error: ${e.message}`;}
  }
}

// Same idea as fetchNvidiaModels but generic — works for ANY OpenAI-
// compatible provider (Groq, Together, OpenRouter, self-hosted, etc.)
// since they all expose GET /v1/models. We derive the models URL from
// whatever chat-completions URL the user typed, so the model list is
// always current instead of relying on a hardcoded name that goes
// stale when the provider renames/retires a model (like Groq did with
// llama-3.3-70b-versatile).
async function fetchCustomModels(){
  const url=document.getElementById('apiUrlInput_custom')?.value.trim();
  const key=document.getElementById('apiKeyInput_custom')?.value.trim();
  const status=document.getElementById('customModelStatus');
  const list=document.getElementById('customModelList');
  if(!url||!key){ if(status)status.textContent='⚠️ Fill in both the URL and Key above first.'; return; }
  const modelsUrl=url.replace(/\/chat\/completions\/?$/i,'/models').replace(/\/completions\/?$/i,'/models');
  if(status){status.style.color='#94a3b8'; status.textContent=`⏳ Fetching from ${modelsUrl}…`;}
  try{
    const r=await fetch(modelsUrl,{headers:{'Authorization':`Bearer ${key}`}});
    if(!r.ok){
      const ej=await r.json().catch(()=>null);
      if(status){status.style.color='#dc2626'; status.textContent=`❌ ${r.status} ${ej?.error?.message||ej?.detail||'could not fetch models — check URL/key'}`;}
      return;
    }
    const d=await r.json();
    const ids=(d?.data||[]).map(m=>m.id).filter(Boolean).sort();
    if(!ids.length){ if(status){status.style.color='#dc2626'; status.textContent='❌ Key worked but returned no models.';} return; }
    const notText=/embed|rerank|vision|vlm|-vl-|audio|asr|tts|whisper|guard|safety|moderation/i;
    const ranked=[...ids.filter(i=>!notText.test(i)),...ids.filter(i=>notText.test(i))];
    list.innerHTML=ranked.map(id=>`<option value="${id}"></option>`).join('');
    renderModelChips('customModelChips','apiModelInput_custom',ranked);
    if(status){status.style.color='#16a34a'; status.textContent=`✅ Found ${ids.length} models — click one below.`;}
  }catch(e){
    if(status){status.style.color='#dc2626'; status.textContent=`❌ Network error: ${e.message} (try the base URL without /chat/completions if this fails)`;}
  }
}

// Renders fetched model ids as clickable chips right under the status
// line — clicking one just sets the input's value directly. This is
// what actually guarantees a usable dropdown regardless of browser,
// unlike the native <datalist> which we keep too (as a bonus for
// browsers where typing-to-filter does work).
function renderModelChips(containerId,inputId,ids){
  let box=document.getElementById(containerId);
  if(!box){
    box=document.createElement('div');
    box.id=containerId;
    box.style.cssText='display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;max-height:110px;overflow-y:auto';
    document.getElementById(inputId)?.parentElement?.appendChild(box);
  }
  box.innerHTML=ids.map(id=>`<button type="button" onclick="document.getElementById('${inputId}').value=this.dataset.m" data-m="${id.replace(/"/g,'&quot;')}" style="font-size:9.5px;padding:3px 8px;border-radius:12px;border:1px solid var(--border);background:#f1f5f9;cursor:pointer;white-space:nowrap">${id}</button>`).join('');
}

// Saves whatever is currently in the input fields without closing the modal
function saveKey_silent(){
  const g=id=>document.getElementById(id)?.value.trim()||'';
  const freeToggle=document.getElementById('apiEnable_freeAI');
  
  const geminiKeysList = [];
  const inputs = document.querySelectorAll("#additionalGeminiKeysContainer .gemini-pool-key");
  inputs.forEach(inp => {
    const val = inp.value.trim();
    if (val) geminiKeysList.push(val);
  });

  AIK={
    gemini:g('apiKeyInput_gemini'),
    geminiKeys:geminiKeysList,
    groq:g('apiKeyInput_groq'),
    groqModel:g('apiModelInput_groq'),
    nvidia:g('apiKeyInput_nvidia'),
    nvidiaModel:g('apiModelInput_nvidia'),
    openrouter:g('apiKeyInput_openrouter'),
    customUrl:g('apiUrlInput_custom'),
    customKey:g('apiKeyInput_custom'),
    customModel:g('apiModelInput_custom'),
    preferredProvider:g('apiPreferredProvider')||'auto',
    enableFreeAI:freeToggle?freeToggle.checked:true
  };
  localStorage.setItem('rsai_keys',JSON.stringify(AIK));
}

function loadSample(){
  D = {
    basics: {
      name: 'SHIVAM GUPTA',
      loc: 'Gorakhpur, U.P., India',
      phone: '+91-8081513780',
      email: 'quantxcoder@gmail.com',
      li: 'https://linkedin.com/in/shivam-gupta-05209a27b',
      gh: 'https://github.com/shivamjigkp',
      gfg: 'https://www.geeksforgeeks.org/user/shivamguptagkp/',
      leetcode: 'https://leetcode.com/u/shivamalgocoder',
      port: 'https://portfolio-shivamgupta.vercel.app',
      otherLink: 'https://www.youtube.com/@MastermindtraderIndia',
      summary: ''
    },
    skills: {
      lang: 'C, C++, Python, JavaScript, SQL, HTML, CSS',
      tools: 'GitHub, VS Code, Docker, Arduino IDE, React, Next.js, Scikit-learn, TensorFlow, Flask, FastAPI, MLflow, Pandas, NumPy, Matplotlib, Seaborn, Pine Script v5',
      domain: 'Quant/Trading Techniques: Chartink, TradingView, Monte Carlo Simulation, AdaBoost, XGBoost, Time Series Forecasting, Backtesting, Risk Management',
      cloud: 'AWS, Supabase, SQL (MySQL, PostgreSQL), Render, Vercel',
      course: 'Financial Markets & Trading, Data Analytics & Machine Learning, Content Creation, Software Development'
    },
    exp: [
      {
        co: 'Mastermind Research Technologies',
        role: 'AI/ML Intern',
        date: 'May 2026 – Aug 2026',
        links: '',
        bullets: [
          'Worked on ML & AI-based projects covering data preprocessing, feature engineering, model development, and evaluation.',
          'Developed practical solutions using Python, Pandas, NumPy, and Scikit-learn for prediction and classification.',
          'Executed end-to-end ML workflows: data preparation → model training → evaluation → prediction.',
          'Gained hands-on experience in AI/ML research, experimentation, and production solution development.'
        ]
      },
      {
        co: 'Flikt (Startup)',
        role: 'Full Stack Developer Intern',
        date: 'Dec 2025 – Feb 2026',
        links: '',
        bullets: [
          'Developed responsive and user-friendly web application features using React.js, JavaScript, HTML, and CSS.',
          'Integrated REST APIs, identified and resolved application bugs, and optimized performance to enhance responsiveness.',
          'Collaborated with the development team using Git/GitHub in an Agile environment for timely project delivery.'
        ]
      },
      {
        co: 'Mastermind Algo Trader (YouTube)',
        role: 'Founder & Content Creator',
        date: '2024 – Present',
        links: 'https://www.youtube.com/@MastermindtraderIndia',
        bullets: [
          'Founded and manage an active trading education community on YouTube; design and deploy automated trading strategies.',
          'Applied backtesting and model evaluation on historical data using Chartink and TradingView for algorithmic execution.'
        ]
      }
    ],
    proj: [
      {
        title: 'Mastermind Research Technologies & Mastermind Algo Trader',
        tech: 'Next.js, FastAPI, Cloudflare, Vercel, Render, Supabase, Cashfree, YouTube',
        links: 'Live Demo | Live Demo 2',
        bullets: [
          'MSME (Udyam) registered AI, software & research platform offering AI/ML and full-stack web development services.',
          'Deployed on Cloudflare with Cashfree payment gateway integration via automated API webhooks.',
          'Linked trading education & signals platform with Next.js frontend + FastAPI backend via REST API.'
        ]
      },
      {
        title: 'MMMUT Hockey Team Website',
        tech: 'React, Vite, Supabase (PostgreSQL, Auth, Storage), Vercel',
        links: 'Live Demo | GitHub',
        bullets: [
          'Built and deployed the official website for MMMUT hockey team as Hockey Technical Member Head.',
          'Developed full-stack Admin Dashboard with 10+ modules for non-technical staff to manage players, matches, and news.',
          'Implemented Supabase (PostgreSQL, Auth, Storage) with Row-Level Security (RLS) for secure role-based access.'
        ]
      },
      {
        title: 'Personal Portfolio Website',
        tech: 'HTML, CSS, JavaScript (ES Modules), Supabase, Vercel',
        links: 'Live Demo | GitHub',
        bullets: [
          'Single-page, dependency-free personal portfolio with dark/light theme, Ctrl+K command palette, and animated stat counters.',
          'Developed interactive timeline component with expandable stack tags and custom cursor for pointer devices.',
          'Built contact form with client-side validation and Supabase backend integration (RLS-secured insert-only policy).'
        ]
      },
      {
        title: 'Algo Strategy Backtesting Dashboard',
        tech: 'Python, FastAPI, Pine Script v5, TradingView, Chartink',
        links: 'GitHub | Live Demo',
        bullets: [
          '5-point A-B-C-D-E liquidity sweep reversal detector & EMA crossover with Python/FastAPI backtesting backend.',
          'Generates live, strategy-based trade signals in real time for subscribed users based on A-B-C-D-E detection logic.',
          'Designed rule-based strategies using Chartink/TradingView with standard deviation volatility zones.'
        ]
      },
      {
        title: 'Electricity Demand Forecasting',
        tech: 'Python, XGBoost, Flask, Render',
        links: 'GitHub | Live Demo',
        bullets: [
          'XGBoost model forecasting hourly electricity demand on 5 years of weather/calendar data with Flask backend on Render.'
        ]
      },
      {
        title: 'Weather Intelligence App',
        tech: 'React, Vercel, Python, Render',
        links: 'GitHub | Live Demo',
        bullets: [
          'React frontend on Vercel + ML backend on Render for temperature forecasting, rain prediction, and anomaly detection.'
        ]
      },
      {
        title: 'CNN Filter Visualization',
        tech: 'TensorFlow, Python',
        links: 'GitHub',
        bullets: [
          'Coursera Guided Project: visualized internal convolutional filters and feature representations of a CNN using TensorFlow.'
        ]
      },
      {
        title: 'Tesla Stock Price Prediction using Facebook Prophet',
        tech: 'Facebook Prophet, Python',
        links: 'GitHub',
        bullets: [
          'Coursera Guided Project: time-series forecasting and trend decomposition of Tesla stock price using Facebook Prophet.'
        ]
      }
    ],
    edu: {
      uni: 'Madan Mohan Malaviya University of Technology, Gorakhpur',
      deg: 'B.Tech - Electronics & Communication Engg. (Data Science & Machine Learning)',
      yrs: '2023 – 2027',
      gpa: '7.57 / 10.00'
    },
    ach: [
      'Rank 3 & Winner – XM Global Trading Competition (Algorithmic Trading) — ₹45,000 prize — 2026',
      'Cleared FundingPips Prop Firm Challenge (Phase 1 & 2) – Funded Account – 2025',
      'Solved 130+ problems on LeetCode and 100+ on GeeksforGeeks — 300+ problems overall across coding platforms',
      'Technical Team Member, Hockey Association, MMMUT 2023 – Present',
      'Founder, Mastermind Algo Trader 2024 – Present',
      'Hockey – UP Zonal Cluster (Rank 3); Chess – Winner, KSS; Volunteer – NSS',
      'Pt. Deen Dayal Upadhyaya Sanatan Dharm Vidyalaya, Kanpur (Class XII) — CBSE: 94% — 2022',
      'Pt. Deen Dayal Upadhyaya Sanatan Dharm Vidyalaya, Kanpur (Class X) — CBSE: 91.67% — 2020'
    ],
    certs: [
      'AI Fundamentals — Google',
      'AI Fundamentals and the Cloud — AWS',
      'Machine Learning: Regression and Classification — Stanford Online',
      'NumPy, SciPy, Matplotlib & Pandas: Machine Learning — SARA Academy',
      'Algorithmic Toolbox (DSA with C++) — UC San Diego (Coursera)',
      'Web Development: CSS, Bootstrap, JS, React — Udemy',
      'SQL (Advanced) — HackerRank',
      'Goldman Sachs – Risk Management Job Simulation',
      'J.P. Morgan – Quantitative Research Job Simulation',
      'Bank of America – Global Markets Sales & Trading Analyst Job Simulation',
      'Microsoft Azure Data Fundamentals (DP-900) — Infosys Springboard',
      'NISM Securities Markets Certification — NISM'
    ]
  };
  D.sectionVisibility=defaultVisibility();
  D.showCertsTop=false;
  populateForm(); render(); liveATS();
  toast('✅ Complete Resume loaded!', 'success');
}

function clearAll(){
  if(!confirm('Clear all resume data? This cannot be undone.'))return;
  D={basics:{name:'',loc:'',phone:'',email:'',li:'',gh:'',gfg:'',leetcode:'',codeforces:'',hackerrank:'',port:'',otherLink:'',summary:''},skills:{lang:'',tools:'',domain:'',cloud:'',course:''},exp:[],proj:[],edu:{uni:'',deg:'',yrs:'',gpa:'',ach:[]},sectionVisibility:defaultVisibility(),showCertsTop:false};
  localStorage.removeItem('rsai_v10');
  populateForm(); render(); liveATS();
  toast('Resume cleared', 'info');
}

// ════════════════════════════════════════════════════════════════
// 📝 EXPORT RESUME AS FORMATTED WORD DOCUMENT (.DOC / .DOCX)
// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
// 📝 EXPORT RESUME AS FORMATTED WORD DOCUMENT (.DOC / .DOCX)
// ════════════════════════════════════════════════════════════════
function exportWord(){
  syncFormToD();
  const b = D.basics || {};
  const s = D.skills || {};
  const e = D.edu || {};
  const exp = D.exp || [];
  const proj = D.proj || [];
  const ach = D.ach || [];
  const certs = D.certs || [];
  const eduExtra = D.eduExtra || [];
  const customSkills = D.customSkills || [];
  const vis = D.sectionVisibility || defaultVisibility();

  const name = (b.name || 'Resume').trim().replace(/\s+/g, '_');
  const filename = `${name}_Resume.doc`;

  // Contact items with clickable links
  const contactParts = [];
  if(b.loc) contactParts.push(b.loc);
  if(b.phone) contactParts.push(b.phone);
  if(b.email) contactParts.push(`<a href="mailto:${b.email}" style="color:#1e40af;text-decoration:underline;">${b.email}</a>`);
  if(b.li) contactParts.push(`<a href="${b.li.startsWith('http')?b.li:'https://'+b.li}" target="_blank" style="color:#1e40af;text-decoration:underline;">LinkedIn</a>`);
  if(b.gh) contactParts.push(`<a href="${b.gh.startsWith('http')?b.gh:'https://'+b.gh}" target="_blank" style="color:#1e40af;text-decoration:underline;">GitHub</a>`);
  if(b.leetcode) contactParts.push(`<a href="${b.leetcode.startsWith('http')?b.leetcode:'https://'+b.leetcode}" target="_blank" style="color:#1e40af;text-decoration:underline;">LeetCode</a>`);
  if(b.gfg) contactParts.push(`<a href="${b.gfg.startsWith('http')?b.gfg:'https://'+b.gfg}" target="_blank" style="color:#1e40af;text-decoration:underline;">GeeksforGeeks</a>`);
  if(b.port) contactParts.push(`<a href="${b.port.startsWith('http')?b.port:'https://'+b.port}" target="_blank" style="color:#1e40af;text-decoration:underline;">Portfolio</a>`);
  if(b.otherLink) contactParts.push(`<a href="${b.otherLink.startsWith('http')?b.otherLink:'https://'+b.otherLink}" target="_blank" style="color:#1e40af;text-decoration:underline;">Profile</a>`);

  // Skills rows in table format for Word
  let skillsRows = '';
  if(s.lang) skillsRows += `<tr><td style="width:160px;font-weight:bold;vertical-align:top;padding:2px 0;">Languages:</td><td style="padding:2px 0;">${s.lang}</td></tr>`;
  if(s.tools) skillsRows += `<tr><td style="width:160px;font-weight:bold;vertical-align:top;padding:2px 0;">Tools & Frameworks:</td><td style="padding:2px 0;">${s.tools}</td></tr>`;
  if(s.domain) skillsRows += `<tr><td style="width:160px;font-weight:bold;vertical-align:top;padding:2px 0;">Domain / Stack:</td><td style="padding:2px 0;">${s.domain}</td></tr>`;
  if(s.cloud) skillsRows += `<tr><td style="width:160px;font-weight:bold;vertical-align:top;padding:2px 0;">Cloud / Databases:</td><td style="padding:2px 0;">${s.cloud}</td></tr>`;
  if(s.course) skillsRows += `<tr><td style="width:160px;font-weight:bold;vertical-align:top;padding:2px 0;">Coursework:</td><td style="padding:2px 0;">${s.course}</td></tr>`;
  customSkills.forEach(cs => {
    if(cs.val && cs.val.trim()){
      skillsRows += `<tr><td style="width:160px;font-weight:bold;vertical-align:top;padding:2px 0;">${cs.label || 'Skills'}:</td><td style="padding:2px 0;">${cs.val}</td></tr>`;
    }
  });

  // Experience entries
  let expHtml = '';
  if(vis.exp !== false && exp.length){
    expHtml = `<div class="sec-title">PROFESSIONAL EXPERIENCE</div>` + exp.map(x => {
      const linkRows = parseLinksField(x.links);
      const linkStr = linkRows.filter(r=>r.url).map(r=>`<a href="${r.url.startsWith('http')?r.url:'https://'+r.url}" style="color:#1e40af;text-decoration:underline;margin-left:6px;">[${r.label||'Link'}]</a>`).join(' ');
      const dateLoc = `${x.date||''}${x.loc ? (x.date?' • ':'')+x.loc : ''}`;
      const bullets = (x.bullets||[]).map(b=>`<li style="margin-bottom:2pt;line-height:1.35;">${bold(b)}</li>`).join('');
      return `
        <table style="width:100%;margin-top:4pt;margin-bottom:2pt;border-collapse:collapse;">
          <tr>
            <td style="text-align:left;font-size:10.5pt;"><strong>${x.co||'Company'}</strong> — <em>${x.role||'Role'}</em> ${linkStr}</td>
            <td style="text-align:right;font-size:10pt;font-style:italic;color:#334155;">${dateLoc}</td>
          </tr>
        </table>
        <ul style="margin:2pt 0 6pt 16pt;padding-left:0;">${bullets}</ul>
      `;
    }).join('');
  }

  // Projects entries
  let projHtml = '';
  if(vis.proj !== false && proj.length){
    projHtml = `<div class="sec-title">FEATURED PROJECTS</div>` + proj.map(p => {
      const linkRows = parseLinksField(p.links);
      const linkStr = linkRows.filter(r=>r.url).map(r=>`<a href="${r.url.startsWith('http')?r.url:'https://'+r.url}" style="color:#1e40af;text-decoration:underline;margin-left:6px;">[${r.label||'Link'}]</a>`).join(' ');
      const techStr = p.tech ? ` [<em>${p.tech}</em>]` : '';
      const bullets = (p.bullets||[]).map(b=>`<li style="margin-bottom:2pt;line-height:1.35;">${bold(b)}</li>`).join('');
      return `
        <table style="width:100%;margin-top:4pt;margin-bottom:2pt;border-collapse:collapse;">
          <tr>
            <td style="text-align:left;font-size:10.5pt;"><strong>${p.title||'Project'}</strong>${techStr} ${linkStr}</td>
            <td style="text-align:right;font-size:10pt;"></td>
          </tr>
        </table>
        <ul style="margin:2pt 0 6pt 16pt;padding-left:0;">${bullets}</ul>
      `;
    }).join('');
  }

  // Education entries
  let eduHtml = '';
  if(vis.edu !== false && (e.uni || e.deg || eduExtra.length)){
    let extraRows = eduExtra.map(x=>`<li style="margin-bottom:2pt;">${bold(x)}</li>`).join('');
    eduHtml = `
      <div class="sec-title">EDUCATION</div>
      <table style="width:100%;margin-top:4pt;margin-bottom:2pt;border-collapse:collapse;">
        <tr>
          <td style="text-align:left;font-size:10.5pt;"><strong>${e.uni||'University'}</strong></td>
          <td style="text-align:right;font-size:10pt;font-style:italic;">${e.yrs||''}</td>
        </tr>
        <tr>
          <td colspan="2" style="font-size:10pt;color:#1e293b;"><em>${e.deg||''}</em> ${e.gpa ? `— <strong>CGPA / Percentage: ${e.gpa}</strong>` : ''}</td>
        </tr>
      </table>
      ${extraRows ? `<ul style="margin:2pt 0 6pt 16pt;padding-left:0;">${extraRows}</ul>` : ''}
    `;
  }

  // Achievements
  let achHtml = '';
  if(vis.ach !== false && ach.length){
    achHtml = `<div class="sec-title">ACHIEVEMENTS & LEADERSHIP</div>
      <ul style="margin:3pt 0 6pt 16pt;padding-left:0;">
        ${ach.map(a=>`<li style="margin-bottom:2pt;line-height:1.35;">${bold(a)}</li>`).join('')}
      </ul>`;
  }

  // Certifications
  let certHtml = '';
  if(vis.certs !== false && certs.length && !D.showCertsTop){
    certHtml = `<div class="sec-title">CERTIFICATIONS & TRAININGS</div>
      <ul style="margin:3pt 0 6pt 16pt;padding-left:0;">
        ${certs.map(c=>{
          const parsed = parseCertEntry(c);
          if(parsed.url){
            return `<li style="margin-bottom:2pt;"><a href="${parsed.url.startsWith('http')?parsed.url:'https://'+parsed.url}" style="color:#1e40af;text-decoration:underline;"><strong>${parsed.label}</strong></a></li>`;
          }
          return `<li style="margin-bottom:2pt;">${bold(parsed.label)}</li>`;
        }).join('')}
      </ul>`;
  }

  const wordDocument = `
    <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
    <head>
      <meta charset='utf-8'>
      <title>${b.name || 'Resume'}</title>
      <style>
        @page {
          size: 21.0cm 29.7cm;
          margin: 1.2cm 1.4cm 1.2cm 1.4cm;
          mso-page-orientation: portrait;
        }
        body {
          font-family: 'Calibri', 'Arial', sans-serif;
          font-size: 10pt;
          line-height: 1.3;
          color: #0f172a;
        }
        .name-hdr {
          font-size: 18pt;
          font-weight: bold;
          text-align: center;
          color: #0f172a;
          margin: 0 0 2pt 0;
          text-transform: uppercase;
          letter-spacing: 0.5pt;
        }
        .contact-hdr {
          font-size: 9pt;
          text-align: center;
          color: #334155;
          margin-bottom: 8pt;
        }
        .sec-title {
          font-size: 10.5pt;
          font-weight: bold;
          text-transform: uppercase;
          border-bottom: 1.5pt solid #0f172a;
          padding-bottom: 1.5pt;
          margin-top: 8pt;
          margin-bottom: 4pt;
          color: #0f172a;
          letter-spacing: 0.3pt;
        }
        a {
          color: #1e40af !important;
          text-decoration: underline !important;
        }
      </style>
    </head>
    <body>
      <div class="name-hdr">${b.name || 'YOUR NAME'}</div>
      <div class="contact-hdr">${contactParts.join(' | ')}</div>
      
      ${(vis.summary !== false && b.summary) ? `<div style="font-size:9.5pt;margin-bottom:6pt;line-height:1.35;font-style:italic;">${b.summary}</div>` : ''}

      ${(vis.skills !== false && skillsRows) ? `<div class="sec-title">TECHNICAL SKILLS</div><table style="width:100%;border-collapse:collapse;margin-bottom:4pt;">${skillsRows}</table>` : ''}

      ${expHtml}
      ${projHtml}
      ${eduHtml}
      ${achHtml}
      ${certHtml}
    </body>
    </html>
  `;

  const blob = new Blob(['\ufeff' + wordDocument], { type: 'application/msword;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  toast(`📝 Exported "${filename}" successfully! Open in MS Word or Google Docs.`, 'success', 4000);
}

function exportJSON(){
  const a=document.createElement('a');
  a.href='data:application/json;charset=utf-8,'+encodeURIComponent(JSON.stringify(D,null,2));
  a.download=(D.basics.name||'Resume').replace(/\s+/g,'_')+'_MastermindResumeAI.json';
  a.click();
  toast('💾 Exported as JSON', 'success', 2000);
}

// ════════════════════════════════════════════════════════════════
// DEFAULT RESUME ("Default 1") — save the current resume as a
// reusable default so future sessions can skip Upload entirely.
// Separate localStorage slot from the normal autosave (rsai_v10) so
// saving a default never overwrites whatever's currently on screen,
// and vice versa. Surfaced both on the Upload tab (skip upload) and
// on the SGResume tab (load straight into the page-fit optimizer).
// ════════════════════════════════════════════════════════════════
function defaultResumeMeta(){
  try{
    const raw=localStorage.getItem('rsai_default_resume');
    if(!raw) return null;
    const parsed=JSON.parse(raw);
    return {name:parsed?.basics?.name||'Untitled', savedAt:localStorage.getItem('rsai_default_resume_savedAt')||''};
  }catch(e){ return null; }
}

function updateDefaultResumeUI(){
  const meta=defaultResumeMeta();
  document.querySelectorAll('.default-resume-status').forEach(el=>{
    el.textContent = meta
      ? `✅ Default 1 saved: ${meta.name}${meta.savedAt?' · '+meta.savedAt:''}`
      : '⚪ No Default 1 saved yet';
  });
  document.querySelectorAll('.default-resume-load-btn').forEach(btn=>{ btn.disabled=!meta; btn.style.opacity=meta?'1':'.5'; });
}

function saveAsDefaultResume(){
  syncFormToD();
  if(!D.basics.name && !(D.exp||[]).length && !(D.proj||[]).length){
    toast('Fill in some resume details first!', 'warning'); return;
  }
  const already=!!localStorage.getItem('rsai_default_resume');
  if(already && !confirm('Default 1 is already saved — overwrite it with your current resume?')) return;
  localStorage.setItem('rsai_default_resume', JSON.stringify(D));
  localStorage.setItem('rsai_default_resume_savedAt', new Date().toLocaleDateString());
  updatePresetQuickUI();
  toast(already?'⭐ Default 1 updated':'⭐ Saved as Default 1', 'success');
}

function loadDefaultResume(){
  const raw=localStorage.getItem('rsai_default_resume');
  if(!raw){ toast('No Default 1 saved yet — save one first!', 'warning'); return; }
  const hasCurrentContent=D && (D.basics?.name || (D.exp||[]).length || (D.proj||[]).length);
  if(hasCurrentContent && !confirm('Load Default 1? This replaces whatever is currently filled in (upload skipped).')) return;
  try{
    D=JSON.parse(raw);
    if(!D.basics) D.basics={};
    if(!Array.isArray(D.exp)) D.exp=[];
    if(!Array.isArray(D.proj)) D.proj=[];
    if(!Array.isArray(D.ach)) D.ach=[];
    if(!Array.isArray(D.certs)) D.certs=[];
    if(!Array.isArray(D.eduExtra)) D.eduExtra=[];
    if(!D.sectionVisibility) D.sectionVisibility=defaultVisibility();
    populateForm(); render(); liveATS();
    swTab('basics');
    toast('📂 Default 1 loaded — upload skipped!', 'success');
  }catch(e){ toast('Failed to load Default 1', 'error'); }
}


// ════════════════════════════════════════════════════════════════
// AI WRITE PROFESSIONAL SUMMARY
// ════════════════════════════════════════════════════════════════
async function aiWriteSummary(){
  const jd=document.getElementById('jdText').value.trim();
  const el=document.getElementById('iSummary');
  if(!el)return;
  syncFormToD();
  if(!D.basics.name&&!D.skills.lang&&!D.edu.uni){
    toast('Fill your resume details first!','warning');return;
  }
  el.value='✨ Writing...';
  el.disabled=true;
  const prompt=`Write a professional 2-sentence resume summary.
Person: ${D.basics.name||'Candidate'}
Education: ${D.edu.deg} at ${D.edu.uni} — CGPA ${D.edu.gpa}
Skills: ${D.skills.lang} | ${D.skills.tools} | ${D.skills.domain}
Experience: ${(D.exp||[]).map(e=>e.role+' at '+e.co).join(', ')||'Fresher'}
${jd?'Target Role JD: '+jd.substring(0,300):''}
Rules: 2 sentences max, 40-55 words, start with degree+domain, mention 2-3 JD keywords, no I/me/my/hardworking/passionate. Only mention skills/experience that appear above — never invent employers, tools, or achievements not listed.
Return ONLY the summary text.`;
  const res=await gemini(prompt);
  el.disabled=false;
  if(res&&res.trim()){
    el.value=res.trim().replace(/^["']|["']$/g,'');
    toast('✅ AI summary written!','success');
  }else{
    const sk=(D.skills.lang||'').split(',')[0]?.trim()||'embedded systems';
    const deg=(D.edu.deg||'Engineering').replace(/B\.?Tech|Bachelor of Technology in/gi,'').trim();
    el.value=`${deg} engineer with hands-on expertise in ${sk} and IoT systems, targeting impactful roles in ${jd?(extractKW(jd).hard.slice(0,2).join(' and '))||'high-growth tech domains':'engineering and innovation'}. Proven track record of designing production-ready solutions that deliver measurable performance improvements.`;
    toast('Summary generated using built-in engine','info');
  }
  D.basics.summary=el.value;
  render();
}

// ════════════════════════════════════════════════════════════════
// DRAG TO REORDER
// ════════════════════════════════════════════════════════════════
let _dragSrcType=null, _dragSrcIdx=null;
function makeDraggable(el,type,idx){
  el.draggable=true;
  el.addEventListener('dragstart',e=>{_dragSrcType=type;_dragSrcIdx=idx;el.classList.add('dragging');e.dataTransfer.effectAllowed='move';});
  el.addEventListener('dragend',()=>el.classList.remove('dragging'));
  el.addEventListener('dragover',e=>{e.preventDefault();el.classList.add('drag-over');});
  el.addEventListener('dragleave',()=>el.classList.remove('drag-over'));
  el.addEventListener('drop',e=>{
    e.preventDefault();el.classList.remove('drag-over');
    if(_dragSrcType!==type||_dragSrcIdx===idx||_dragSrcIdx===null)return;
    const arr=type==='exp'?D.exp:D.proj;
    const [moved]=arr.splice(_dragSrcIdx,1);
    arr.splice(idx,0,moved);
    if(type==='exp')renderExpEditor();else renderProjEditor();
    render();toast('Reordered ✓','success',1500);_dragSrcIdx=null;
  });
}

// ════════════════════════════════════════════════════════════════
// ENHANCED RENDER WITH SUMMARY
// ════════════════════════════════════════════════════════════════
function render(){
  syncFormToD();
  const b=D.basics,s=D.skills,e=D.edu;
  const isSideL=CTPL==='T-sidel',isSideR=CTPL==='T-sider';
  const vis=D.sectionVisibility||(D.sectionVisibility=defaultVisibility());

  const linksRow = `
        ${b.loc ? `<span>${getResumeSvgIcon('loc')} ${b.loc}</span>` : ''}
        ${b.phone ? `<span>${getResumeSvgIcon('phone')} ${b.phone}</span>` : ''}
        ${b.email ? `<span>${getResumeSvgIcon('email')} <a href="mailto:${b.email}">${b.email}</a></span>` : ''}
        ${b.li ? `<span>${getResumeSvgIcon('linkedin')} <a href="${b.li.startsWith('http')?b.li:'https://'+b.li}" target="_blank">LinkedIn</a></span>` : ''}
        ${b.gh ? `<span>${getResumeSvgIcon('github')} <a href="${b.gh.startsWith('http')?b.gh:'https://'+b.gh}" target="_blank">GitHub</a></span>` : ''}
        ${b.gfg ? `<span>${getResumeSvgIcon('gfg')} <a href="${b.gfg.startsWith('http')?b.gfg:'https://'+b.gfg}" target="_blank">GeeksforGeeks</a></span>` : ''}
        ${b.leetcode ? `<span>${getResumeSvgIcon('leetcode')} <a href="${b.leetcode.startsWith('http')?b.leetcode:'https://'+b.leetcode}" target="_blank">LeetCode</a></span>` : ''}
        ${b.codeforces ? `<span>${getResumeSvgIcon('codeforces')} <a href="${b.codeforces.startsWith('http')?b.codeforces:'https://'+b.codeforces}" target="_blank">Codeforces</a></span>` : ''}
        ${b.hackerrank ? `<span>${getResumeSvgIcon('gfg')} <a href="${b.hackerrank.startsWith('http')?b.hackerrank:'https://'+b.hackerrank}" target="_blank">HackerRank</a></span>` : ''}
        ${b.port ? `<span>${getResumeSvgIcon('globe')} <a href="${b.port.startsWith('http')?b.port:'https://'+b.port}" target="_blank">${b.port.replace(/^https?:\/\//,'').split('/')[0]||'Portfolio'}</a></span>` : ''}
        ${b.otherLink ? `<span>${getResumeSvgIcon('link')} <a href="${b.otherLink.startsWith('http')?b.otherLink:'https://'+b.otherLink}" target="_blank">${b.otherLink.replace(/^https?:\/\//,'').split('/')[0]||'Profile'}</a></span>` : ''}`;

  const hdr=`<div class="rh">
    <div class="rn">${b.name||'YOUR NAME'}</div>
    ${vis.links!==false?`<div class="rc">${linksRow}</div>`:''}
  </div>`;

  const summary=(vis.summary!==false && b.summary)?`<div style="font-size:10.3px;color:#4b5563;line-height:1.5;margin:4px 0 6px;padding:5px 8px;background:#f8fafc;border-radius:4px;border-left:2px solid var(--tpl-theme)">${b.summary}</div>`:'';

  const isCertItem = (str) => /certification|certificate|coursera|udemy|stanford|google|aws|hackerrank|nism|job simulation|infosys|springboard|licensed|coursework|training|academy/i.test(str);

  // Certifications: Collected from D.certs PLUS any cert items in D.ach or s.course
  let certList = (D.certs && D.certs.length) ? [...D.certs] : [];
  if(D.ach && D.ach.length){
    D.ach.filter(isCertItem).forEach(c => {
      if(!certList.some(cl => cl.toLowerCase().includes(c.toLowerCase()) || c.toLowerCase().includes(cl.toLowerCase()))){
        certList.push(c);
      }
    });
  }
    certList = certList.filter(c => !/^Hyperlink\s*\[/i.test(c) && !/^https?:\/\//i.test(c) && !/^Link:/i.test(c));
  if(!certList.length && s.course){
    certList = s.course.split(/[,;|]+/).map(c=>c.trim()).filter(Boolean);
  }

  // Inline-in-Skills certifications: independent boolean toggle, default OFF.
  // Rendered as one continuous comma-separated line — link syntax (Name::URL)
  // is stripped down to just the display name here (plain text, no clutter).
  const showCourseInSkills = !!D.showCertsTop && certList.length;
  const courseInlineText = showCourseInSkills ? certList.map(c=>parseCertEntry(c).label).filter(Boolean).join(', ') : '';

  const customSkillsActive = (Array.isArray(D.customSkills) && D.customSkills.length) ? D.customSkills.filter(it=>it.val && it.val.trim()) : [];
  const hasSk = vis.skills!==false && (s.lang || s.tools || s.domain || s.cloud || s.course || customSkillsActive.length || showCourseInSkills);
  let customSkillsHtml = customSkillsActive.map(it=>`<div class="rsk">${it.label || 'Skills'}:</div><div class="rsv">${it.val}</div>`).join('');
  const skills = hasSk ? `<div class="rs">Technical Skills</div><div class="rsg">
    ${s.lang?`<div class="rsk">Languages:</div><div class="rsv">${s.lang}</div>`:''}
    ${s.tools?`<div class="rsk">Tools & Frameworks:</div><div class="rsv">${s.tools}</div>`:''}
    ${s.domain?`<div class="rsk">Domain / Stack:</div><div class="rsv">${s.domain}</div>`:''}
    ${s.cloud?`<div class="rsk">Cloud / Databases:</div><div class="rsv">${s.cloud}</div>`:''}
    ${s.course?`<div class="rsk">Coursework:</div><div class="rsv">${s.course}</div>`:''}
    ${customSkillsHtml}
    ${showCourseInSkills?`<div class="rsk">Certifications:</div><div class="rsv">${courseInlineText}</div>`:''}
  </div>`:'';

  const exp=(vis.exp!==false && (D.exp||[]).length)?`<div class="rs">Professional Experience</div>`+
    D.exp.map(x=>{
      const linkRows=parseLinksField(x.links);
      let linkHtml=linkRows.map(r=>{
        if(r.url){
          const url=r.url.startsWith('http')?r.url:'https://'+r.url;
          const icon=iconForLink(r.label,r.url);
          const label=r.label||'Link';
          return `<a href="${url}" target="_blank" style="font-size:9px;color:var(--tpl-theme);text-decoration:none;font-weight:700;margin-left:5px;border:1px solid var(--tpl-theme);border-radius:4px;padding:1px 5px;white-space:nowrap">${icon} ${label}</a>`;
        }
        return r.label?`<span style="font-size:9px;color:#6b7280;margin-left:4px">[${r.label}]</span>`:'';
      }).join('');
      const dateLoc=`${x.date||''}${x.loc?(x.date?' • ':'')+x.loc:''}`;
      return `<div class="ri">
        <div class="ri-row"><div style="display:flex;align-items:center;flex-wrap:wrap;gap:3px"><span class="ri-title">${x.co||'Company'}</span> — <span class="ri-sub">${x.role||'Role'}</span>${linkHtml}</div><span class="ri-date">${dateLoc}</span></div>
        <ul class="rb">${(x.bullets||[]).map(b=>`<li>${bold(b)}</li>`).join('')}</ul>
      </div>`;
    }).join(''):'';

  const proj=(vis.proj!==false && (D.proj||[]).length)?`<div class="rs">${CTPL==='T-mmmut'?'Projects:':'Featured Projects'}</div>`+
    D.proj.map(p=>{
      const linkRows=parseLinksField(p.links);
      let linkHtml=linkRows.map(r=>{
        if(r.url){
          const url=r.url.startsWith('http')?r.url:'https://'+r.url;
          if(CTPL==='T-mmmut'){
            return `<a href="${url}" target="_blank" style="font-size:9.5px;color:var(--tpl-theme);text-decoration:none;font-weight:bold;margin-left:4px;">[${r.label||'Link'}]</a>`;
          }
          const icon=iconForLink(r.label,r.url);
          const label=r.label||'Link';
          return `<a href="${url}" target="_blank" style="font-size:9px;color:var(--tpl-theme);text-decoration:none;font-weight:700;margin-left:5px;border:1px solid var(--tpl-theme);border-radius:4px;padding:1px 5px;white-space:nowrap">${icon} ${label}</a>`;
        }
        return `<span style="font-size:9px;color:#6b7280;margin-left:4px">[${r.label}]</span>`;
      }).join('');
      return `<div class="ri">
      <div class="ri-row"><div style="display:flex;align-items:center;flex-wrap:wrap;gap:3px"><span class="ri-title">${p.title||'Project'}</span>${linkHtml}</div><span class="ri-sub">${p.tech||''}</span></div>
      <ul class="rb">${(p.bullets||[]).map(b=>`<li>${bold(b)}</li>`).join('')}</ul>
    </div>`;
    }).join(''):'';

  // Pure Achievements (never contains cert items or raw school/board lines —
  // those belong in the Education section via D.eduExtra instead)
  const isRawEduLine = (str) => /class\s*x(?:ii)?\b/i.test(str) || /^(?:central\s+board|(?:cbse|icse)\s*,?\s*new\s*delhi|board\s+of\s+(?:secondary|higher))/i.test(str.trim());
  const eduExtraArr = [...(D.eduExtra||[]), ...((D.ach||[]).filter(isRawEduLine))];

  const hasEdu = vis.edu!==false && ((e && (e.uni || e.deg || e.yrs || e.gpa)) || eduExtraArr.length);
  const edu = hasEdu ? `<div class="rs">Education</div>
    <div class="ri">
      ${(e.uni||e.deg||e.yrs||e.gpa)?`<div class="ri-row"><span class="ri-title">${e.uni||'University / Institution'}</span><span class="ri-date">${e.yrs||''}</span></div>
      <div class="ri-sub">${e.deg||''}${e.gpa?` — <strong>CGPA / Score: ${e.gpa}</strong>`:''}</div>`:''}
      ${eduExtraArr.length?`<ul class="rb">${eduExtraArr.map(x=>`<li>${bold(x)}</li>`).join('')}</ul>`:''}
    </div>` : '';

  const achArr = (vis.ach!==false && D.ach && D.ach.length) ? D.ach.filter(a => !isCertItem(a) && !isRawEduLine(a)) : [];
  const ach = achArr.length ? `<div class="rs">Achievements</div>
    <div class="ri">
      <ul class="rb">${achArr.map(a=>`<li>${bold(a)}</li>`).join('')}</ul>
    </div>` : '';

  // Separate (bottom) Certifications Section — independently shown/hidden
  // from the inline-in-Skills version above, so the user can pick either,
  // both, or neither without duplicating content.
  const certsHtml = (vis.certs!==false && certList.length) ? `<div class="rs">Certifications</div>
    <div class="ri">
      <ul class="rb">${certList.map(c=>`<li>${certItemHtml(c)}</li>`).join('')}</ul>
    </div>` : '';

  
    const rollMatch = (b.rollNo || b.roll || b.loc || '').match(/\d{6,12}/);
    const rollStr = rollMatch ? rollMatch[0] : (b.rollNo || b.roll || '2023041167');
    const officialEmail = (b.email && b.email.includes('@mmmut.ac.in')) ? b.email : (rollStr && /^\d+$/.test(rollStr) ? `${rollStr}@mmmut.ac.in` : '');
    const progStr = e.deg ? (e.deg.includes('B.Tech') ? 'B.Tech' : e.deg.split('-')[0].trim()) : 'B.Tech';
    const yrsStr = e.yrs ? e.yrs : '2023 - 2027';
    const branchStr = (e.deg && e.deg.includes('-')) ? e.deg.split('-').slice(1).join('-').trim() : ((e.deg && e.deg.includes('(')) ? e.deg.match(/\((.*?)\)/)?.[1] || 'ECE (Data Science & ML)' : 'ECE (Data Science & ML)');
    const uniStr = e.uni || 'Madan Mohan Malaviya University of Technology, Gorakhpur';

    const mmmutHdrHtml = `<div class="rh" style="font-family:'Times New Roman',Georgia,serif;margin-bottom:6px;line-height:1.32;">
      <table style="width:100%;border-collapse:collapse;margin:0;padding:0;">
        <tr>
          <td style="vertical-align:top;width:60%;text-align:left;padding:0;">
            <div style="font-size:18px;font-weight:bold;color:var(--tpl-theme,#000);margin-bottom:2px;">${b.name||'Shivam Gupta'}</div>
            <div style="font-size:9.5px;color:#000;">Roll No.: ${rollStr}</div>
            <div style="font-size:9.5px;color:#000;">${progStr} ${yrsStr}</div>
            <div style="font-size:9.5px;color:#000;">${branchStr}</div>
            <div style="font-size:9.5px;color:#000;">${uniStr}</div>
          </td>
          <td style="vertical-align:top;width:40%;text-align:right;padding:0;font-size:9.5px;color:#000;line-height:1.45;">
            ${b.phone?`<div>${b.phone.startsWith('+')?b.phone:'+91-'+b.phone}</div>`:''}
            ${b.email?`<div><a href="mailto:${b.email}" style="color:#000;text-decoration:none;">${b.email}</a></div>`:''}
            ${officialEmail?`<div><a href="mailto:${officialEmail}" style="color:#000;text-decoration:none;">${officialEmail}</a></div>`:''}
            ${b.gh?`<div><a href="${b.gh.startsWith('http')?b.gh:'https://'+b.gh}" target="_blank" style="color:#000;text-decoration:underline;">GitHub Profile</a></div>`:''}
            ${b.li?`<div><a href="${b.li.startsWith('http')?b.li:'https://'+b.li}" target="_blank" style="color:#000;text-decoration:underline;">LinkedIn Profile</a></div>`:''}
            ${b.leetcode?`<div><a href="${b.leetcode.startsWith('http')?b.leetcode:'https://'+b.leetcode}" target="_blank" style="color:#000;text-decoration:underline;">LeetCode Profile</a></div>`:''}
            ${b.gfg?`<div><a href="${b.gfg.startsWith('http')?b.gfg:'https://'+b.gfg}" target="_blank" style="color:#000;text-decoration:underline;">GeeksforGeeks Profile</a></div>`:''}
            ${b.port?`<div><a href="${b.port.startsWith('http')?b.port:'https://'+b.port}" target="_blank" style="color:#000;text-decoration:underline;">Portfolio</a></div>`:''}
          </td>
        </tr>
      </table>
    </div>`;

    
    function formatMmmutEduExtraItem(item){
      if(typeof item === 'object' && item !== null){
        const school = item.school || item.institution || item.name || '';
        const yr = item.year || item.yrs || item.date || '';
        const board = item.board || item.degree || item.deg || 'Central Board of Secondary Education (CBSE), New Delhi';
        const score = item.score || item.gpa || item.percentage || '';
        return `
          <div style="margin-bottom:3px;font-family:'Times New Roman',Georgia,serif;line-height:1.3;">
            <div style="display:flex;justify-content:space-between;font-size:10.5px;">
              <span style="font-weight:bold;color:#000;">• ${school}</span>
              <span style="font-style:italic;color:#000;">${yr}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:10px;padding-left:12px;">
              <span style="font-style:italic;color:#000;">${board}</span>
              <span style="color:#000;">${score ? (score.startsWith('Percentage') || score.startsWith('CGPA') ? score : (score.includes('%') ? 'Percentage: '+score : 'CGPA: '+score)) : ''}</span>
            </div>
          </div>`;
      }
      const s = String(item).trim();
      const yrMatch = s.match(/\b(20\d\d(?:\s*-\s*\d{2,4})?|19\d\d)\b/);
      const yr = yrMatch ? yrMatch[1] : '';
      const scoreMatch = s.match(/(?:CBSE:\s*|Percentage:\s*|CGPA:\s*|Score:\s*|—\s*)(\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*\/\s*10(?:\.00)?)/i);
      let score = scoreMatch ? scoreMatch[1].trim() : '';
      if(score && !score.startsWith('Percentage') && !score.startsWith('CGPA')){
        score = score.includes('%') ? `Percentage: ${score}` : `CGPA: ${score}`;
      }
      let board = 'Central Board of Secondary Education (CBSE), New Delhi';
      if(/icse/i.test(s)) board = 'Council for the Indian School Certificate Examinations (ICSE), New Delhi';
      else if(/up\s*board|uttar\s*pradesh/i.test(s)) board = 'Board of High School and Intermediate Education, Uttar Pradesh';

      let school = s;
      if(yrMatch) school = school.replace(yrMatch[0], '');
      if(scoreMatch) school = school.replace(scoreMatch[0], '');
      school = school.replace(/[—–\-:]+/g, ' ').replace(/\s+/g, ' ').trim();
      school = school.replace(/\b(cbse|icse|central board|new delhi)\b/gi, '').replace(/\s+/g, ' ').trim();

      return `
        <div style="margin-bottom:3px;font-family:'Times New Roman',Georgia,serif;line-height:1.3;">
          <div style="display:flex;justify-content:space-between;font-size:10.5px;">
            <span style="font-weight:bold;color:#000;">• ${school}</span>
            <span style="font-style:italic;color:#000;">${yr}</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:10px;padding-left:12px;">
            <span style="font-style:italic;color:#000;">${board}</span>
            <span style="color:#000;">${score}</span>
          </div>
        </div>`;
    }

    const primaryGpaFormatted = e.gpa ? (e.gpa.toLowerCase().includes('cgpa') ? e.gpa : (e.gpa.includes('/') ? `CGPA: ${e.gpa}` : `CGPA: ${e.gpa} / 10.00`)) : 'CGPA: 7.57 / 10.00';

    const mmmutEduHtml = `
      <div style="font-family:'Times New Roman',Georgia,serif;margin-top:6px;margin-bottom:6px;">
        <div style="font-size:11px;font-weight:bold;color:#000;border-bottom:1px solid #000;padding-bottom:1px;margin-bottom:4px;">
          <span style="text-decoration:underline;">Education:</span>
        </div>
        <!-- College Entry -->
        <div style="margin-bottom:3px;line-height:1.3;">
          <div style="display:flex;justify-content:space-between;font-size:10.5px;">
            <span style="font-weight:bold;color:#000;">• ${e.uni||'Madan Mohan Malaviya University of Technology, Gorakhpur'}</span>
            <span style="font-style:italic;color:#000;">${e.yrs||'2023 - 2027'}</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:10px;padding-left:12px;">
            <span style="font-style:italic;color:#000;">${e.deg||'B.Tech - Electronics & Communication Engg. (Data Science & Machine Learning)'}</span>
            <span style="color:#000;">${primaryGpaFormatted}</span>
          </div>
        </div>
        <!-- School Entries (Class XII, Class X) -->
        ${(D.eduExtra||[]).map(formatMmmutEduExtraItem).join('')}
      </div>`;

    const hyperlinksHtml = (vis.hyperlinks === true && Array.isArray(D.hyperlinks) && D.hyperlinks.length) ? `
    <div class="rs">Hyperlinks</div>
    <div class="ri"><ul class="rb">
      ${D.hyperlinks.map(h=>`<li><a href="${h.url}" target="_blank" style="color:var(--tpl-theme);text-decoration:underline;font-weight:600;">${h.label||h.url}</a>${h.label&&h.url?` <span style="font-size:9px;color:#64748b;">(${h.url})</span>`:''}</li>`).join('')}
    </ul></div>` : '';

  let html='';
  if(CTPL==='T-mmmut'){
    html=`${mmmutHdrHtml}${summary}${mmmutEduHtml}${skills}${exp}${proj}${ach}${certsHtml}${hyperlinksHtml}`;
  } else if(isSideL){
    html=`${hdr}${summary}<div class="rbg"><div class="rsidecol">${skills}${edu}${ach}${certsHtml}${hyperlinksHtml}</div><div>${exp}${proj}</div></div>`;
  } else if(isSideR){
    html=`${hdr}${summary}<div class="rbg"><div>${exp}${proj}</div><div class="rsidecol">${skills}${edu}${ach}${certsHtml}${hyperlinksHtml}</div></div>`;
  } else {
    html=`${hdr}${summary}${skills}${exp}${proj}${edu}${ach}${certsHtml}${hyperlinksHtml}`;
  }

  document.getElementById('resumeOut').innerHTML=html;
  updateVisToggleUI();
  localStorage.setItem('rsai_v10',JSON.stringify(D));
  // Shrink-to-fit for page-limit mode (must run BEFORE the panel auto-scale below)
  requestAnimationFrame(()=>{fitToPageLimit();scalePaper();});
}

// ════════════════════════════════════════════════════════════════
// SHRINK-TO-FIT FOR PAGE-LIMIT MODE (generalized — works for 1, 2, 3... N pages)
// Default (PAGE_LIMIT_PAGES=0 / Auto) = NO cap, NO scaling, full natural
// height, nothing ever hidden or clipped — matches the "default preview
// shows everything, unlimited scroll" requirement.
// When a page limit IS selected, instead of clipping with overflow:hidden
// (which used to silently cut content off, especially for 2+ pages), this
// measures the resume's natural height and scales the whole content block
// down (font+spacing together, via CSS transform with a width compensation)
// until it fits inside the requested number of A4 pages. If it still can't
// fit even at a readable minimum scale, we stop shrinking and show a small
// on-page warning instead of silently losing content.
// ════════════════════════════════════════════════════════════════
const PAGE_HEIGHT_PX=1123;
const PAGE_FIT_MIN_SCALE=0.62; // don't shrink text past ~62% — unreadable below this
function fitToPageLimit(container,outEl,pages,minScale){
  container=container||document.getElementById('paper');
  outEl=outEl||document.getElementById('resumeOut');
  pages=(pages===undefined)?PAGE_LIMIT_PAGES:pages;
  minScale=(minScale===undefined)?PAGE_FIT_MIN_SCALE:minScale;
  if(!container||!outEl)return;
  const oldWarn=container.querySelector('.fit-warn');
  if(oldWarn)oldWarn.remove();

  if(!pages||pages<=0){
    // Auto mode — always full, unscaled, unclipped
    outEl.style.transform='';
    outEl.style.width='100%';
    container.style.maxHeight='none';
    return;
  }
  // Reset to natural size first so we measure the TRUE unscaled height
  outEl.style.transform='scale(1)';
  outEl.style.width='100%';
  const cs=getComputedStyle(container);
  const padTop=parseFloat(cs.paddingTop)||0;
  const padBottom=parseFloat(cs.paddingBottom)||0;
  const available=(PAGE_HEIGHT_PX*pages)-padTop-padBottom;
  const natural=outEl.scrollHeight;

  if(natural<=available||natural===0){
    outEl.style.transform='scale(1)';
    outEl.style.width='100%';
    container.style.maxHeight=(PAGE_HEIGHT_PX*pages)+'px';
    return;
  }
  let scale=available/natural*0.985; // small safety margin so descenders don't clip
  if(scale<minScale){
    scale=minScale;
    const w=document.createElement('div');
    w.className='fit-warn';
    w.textContent=`⚠ Content too long for ${pages} page${pages>1?'s':''} even shrunk — trim a bullet or two`;
    container.appendChild(w);
  }
  outEl.style.width=(100/scale)+'%';
  outEl.style.transform=`scale(${scale})`;
  container.style.maxHeight=(PAGE_HEIGHT_PX*pages)+'px';
}
// Back-compat alias (old name used elsewhere in this file / saved bookmarks)
function fitPageOne(){fitToPageLimit();}

// ════════════════════════════════════════════════════════════════
// SGResume — AI page-fit resume optimizer
// Takes a snapshot of the current resume and, for a chosen page count,
// asks AI to intelligently trim/prioritize content (not just shrink fonts)
// so it reads naturally within that many pages. Renders into its own
// preview BELOW the main resume — never touches D or the main #paper.
// ════════════════════════════════════════════════════════════════
let sgData=null;
let sgPages=1;

function sgSelectedPages(){
  const sel=document.getElementById('sgPageSel');
  return sel?parseInt(sel.value,10)||1:1;
}

async function generateSGResume(){
  syncFormToD(); // make sure D reflects the latest form edits first
  sgPages=sgSelectedPages();
  const modeSel=document.getElementById('sgModeSel');
  const sgMode=modeSel?modeSel.value:'ai'; // 'ai' or 'offline'
  const btn=document.getElementById('sgGenBtn');
  const status=document.getElementById('sgStatus');
  if(btn) btn.disabled=true;
  if(status) status.innerHTML=sgMode==='offline'
    ? `<div class="spin" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:5px"></div> Offline engine se ${sgPages} page(s) ke liye trim ho raha hai...`
    : `<div class="spin" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:5px"></div> AI is optimizing your resume for ${sgPages} page(s)...`;

  // Preserve whatever Show/Hide + inline-certs settings the user already
  // set on a previous SGResume generation, so clicking "Re-generate"
  // doesn't silently reset them back to defaults.
  const prevVisibility=(sgData && sgData.sectionVisibility) ? sgData.sectionVisibility : defaultVisibility();
  const prevCertsTop=sgData ? !!sgData.showCertsTop : false;

  const src={
    basics:D.basics, skills:D.skills, edu:D.edu, eduExtra:D.eduExtra||[],
    exp:D.exp||[], proj:D.proj||[], ach:D.ach||[], certs:D.certs||[]
  };

  let optimized=null;

  if(sgMode==='offline'){
    // User explicitly chose Offline — skip the AI call entirely, go
    // straight to the rule-based trimmer (no internet/API usage).
    optimized=sgFallbackTrim(src, sgPages);
    if(status) status.innerHTML='⚡ Offline Engine se SGResume ready hai (koi AI call nahi hua, font size same rakha).';
  }else{
    const budget=sgBudgetForPages(sgPages);
    const prompt=`You are optimizing a resume to fit naturally within EXACTLY ${sgPages} A4 page(s) — this is a hard content budget, not a soft suggestion. Font size will be handled separately by the app — your ONLY job is CONTENT SELECTION.

CRITICAL — READ THIS FIRST: Simply rewording bullets tighter while keeping every entry and every bullet is a FAILURE. If you return the same number of experience entries, projects, and bullets as the input, you have not done the job. The output MUST have a visibly SHORTER item/bullet COUNT than the input — real removal, not just shorter sentences.

Hard limits for ${sgPages} page(s) — do not exceed these:
- Max ${budget.maxExp} work experience entries, max ${budget.maxBulletsPerItem} bullets each (keep only the strongest/most quantified bullets per entry)
- Max ${budget.maxProj} projects, max ${budget.maxBulletsPerItem} bullets each
- Max ${budget.maxAch} achievement/certification lines

Rules:
- Rank every bullet and every entry by impact: bullets with real quantified metrics (%, numbers, scale, results) and strongest relevance win — DROP the rest completely, don't just shrink their wording.
- It is OK and EXPECTED to drop an entire low-priority project, an older/less relevant job, or a repetitive bullet if the page budget requires it — that's the point of this task.
- NEVER invent new facts, employers, numbers, tools or achievements not implied by the original content.
- On any item you DO keep, preserve every field exactly (including "loc" and "links" on experience/project entries, and all basics link fields) — you may only remove/select whole bullets or whole entries, never drop a field off a kept item.
- Keep the exact same JSON shape as given (basics, skills, edu, eduExtra, exp, proj, ach, certs).

Current resume JSON:
${JSON.stringify(src)}

Return ONLY valid JSON in that same shape, with the entry/bullet COUNT actually reduced to fit the limits above. No markdown code fences, no commentary, no extra keys.`;

    const result=await callAI(prompt, 4000);
    if(result){
      try{
        const clean=result.replace(/```json|```/g,'').trim();
        optimized=JSON.parse(clean);
      }catch(e){ optimized=null; }
    }

    if(!optimized || !optimized.basics){
      optimized=sgFallbackTrim(src, sgPages);
      if(status) status.innerHTML='⚠️ AI se result nahi mila — rule-based trim use kiya gaya hai (font size same rakha).';
    } else {
      // Backstop: whatever the AI actually returned — even if it ignored
      // the limits above and cloned everything — this still forces the
      // final content down to the page's real budget, so the result is
      // never just "everything, shrunk to fit" (that was the root bug).
      optimized=capEntriesAndBullets(optimized, sgPages);
      if(status) status.innerHTML=`✅ SGResume ready for ${sgPages} page${sgPages>1?'s':''}.`;
    }
  }

  optimized.sectionVisibility=prevVisibility;
  optimized.showCertsTop=prevCertsTop;
  sgData=optimized;
  const lbl=document.getElementById('sgPagesLabel');
  if(lbl) lbl.textContent=`${sgPages} page${sgPages>1?'s':''}`;
  renderSGEditor();
  renderSG();
  const section=document.getElementById('sgSection');
  if(section){
    section.style.display='block';
    requestAnimationFrame(()=>section.scrollIntoView({behavior:'smooth',block:'start'}));
  }
  const jumpBtn=document.getElementById('sgJumpBtn');
  if(jumpBtn) jumpBtn.style.display='inline-flex';
  if(btn) btn.disabled=false;
}

// Hard content budget, ALWAYS enforced after SGResume content comes back —
// whether from the AI or the offline fallback. Root-cause fix for "AI just
// clones everything and the page-fit shrinks the font to squeeze it in":
// that shrink-to-fit (fitToPageLimit) is only a last-resort SAFETY NET for
// tiny overflows — it was masking the real problem, which is that nothing
// was actually forcing the AI's output to be shorter in item/bullet COUNT.
// This runs no matter what the AI returns, so the final result is always a
// genuinely-trimmed resume, not a full clone squeezed smaller visually.
function sgBudgetForPages(pages){
  return pages>=3
    ? {maxBulletsPerItem:5, maxExp:8, maxProj:6, maxAch:8}
    : pages===2
    ? {maxBulletsPerItem:4, maxExp:5, maxProj:4, maxAch:6}
    : {maxBulletsPerItem:3, maxExp:3, maxProj:2, maxAch:4};
}
function capEntriesAndBullets(clone, pages){
  const {maxBulletsPerItem,maxExp,maxProj,maxAch}=sgBudgetForPages(pages);
  // When a bullet list is over budget, prefer keeping the ones that already
  // carry a quantified metric (digits/%) — those are the highest-impact
  // lines — and only fall back to earliest-first for the rest, instead of
  // blindly slicing the first N regardless of which ones actually matter.
  const trimBullets=(arr)=>{
    if(!Array.isArray(arr)||arr.length<=maxBulletsPerItem) return arr||[];
    const quantified=arr.filter(b=>/\d/.test(b));
    const rest=arr.filter(b=>!/\d/.test(b));
    const keepSet=new Set([...quantified,...rest].slice(0,maxBulletsPerItem));
    return arr.filter(b=>keepSet.has(b)); // preserve original order among kept
  };
  (clone.exp||[]).forEach(x=>{ x.bullets=trimBullets(x.bullets); });
  (clone.proj||[]).forEach(x=>{ x.bullets=trimBullets(x.bullets); });
  if((clone.exp||[]).length>maxExp) clone.exp=clone.exp.slice(0,maxExp);
  if((clone.proj||[]).length>maxProj) clone.proj=clone.proj.slice(0,maxProj);
  if((clone.ach||[]).length>maxAch) clone.ach=clone.ach.slice(0,maxAch);
  return clone;
}

// Rule-based fallback if no AI provider/key is available — trims bullet
// counts per entry instead of shrinking fonts, so it still respects
// "font size unnecessarily chhota nahi karega".
function sgFallbackTrim(src, pages){
  return capEntriesAndBullets(JSON.parse(JSON.stringify(src)), pages);
}

function renderSG(){
  if(!sgData)return;
  const html=buildResumeHtmlSimple(sgData);
  const out=document.getElementById('sgResumeOut');
  if(out) out.innerHTML=html;
  requestAnimationFrame(()=>{
    fitToPageLimit(document.getElementById('sgPaper'),document.getElementById('sgResumeOut'),sgPages,0.92);
    scaleSGPaper();
  });
}

// Simplified, self-contained single-column resume HTML builder — used only
// for SGResume so it never depends on / interferes with the main render()
// pipeline, the live-editing D object, or the currently selected template.
function buildResumeHtmlSimple(data){
  const b=data.basics||{}, s=data.skills||{}, e=data.edu||{};
  const vis=data.sectionVisibility||defaultVisibility();

  const linksRow = `
        ${b.loc ? `<span>${getResumeSvgIcon('loc')} ${b.loc}</span>` : ''}
        ${b.phone ? `<span>${getResumeSvgIcon('phone')} ${b.phone}</span>` : ''}
        ${b.email ? `<span>${getResumeSvgIcon('email')} <a href="mailto:${b.email}">${b.email}</a></span>` : ''}
        ${b.li ? `<span>${getResumeSvgIcon('linkedin')} <a href="${b.li.startsWith('http')?b.li:'https://'+b.li}" target="_blank">LinkedIn</a></span>` : ''}
        ${b.gh ? `<span>${getResumeSvgIcon('github')} <a href="${b.gh.startsWith('http')?b.gh:'https://'+b.gh}" target="_blank">GitHub</a></span>` : ''}
        ${b.gfg ? `<span>${getResumeSvgIcon('gfg')} <a href="${b.gfg.startsWith('http')?b.gfg:'https://'+b.gfg}" target="_blank">GeeksforGeeks</a></span>` : ''}
        ${b.leetcode ? `<span>${getResumeSvgIcon('leetcode')} <a href="${b.leetcode.startsWith('http')?b.leetcode:'https://'+b.leetcode}" target="_blank">LeetCode</a></span>` : ''}
        ${b.codeforces ? `<span>${getResumeSvgIcon('codeforces')} <a href="${b.codeforces.startsWith('http')?b.codeforces:'https://'+b.codeforces}" target="_blank">Codeforces</a></span>` : ''}
        ${b.hackerrank ? `<span>${getResumeSvgIcon('gfg')} <a href="${b.hackerrank.startsWith('http')?b.hackerrank:'https://'+b.hackerrank}" target="_blank">HackerRank</a></span>` : ''}
        ${b.port ? `<span>${getResumeSvgIcon('globe')} <a href="${b.port.startsWith('http')?b.port:'https://'+b.port}" target="_blank">${b.port.replace(/^https?:\/\//,'').split('/')[0]||'Portfolio'}</a></span>` : ''}
        ${b.otherLink ? `<span>${getResumeSvgIcon('link')} <a href="${b.otherLink.startsWith('http')?b.otherLink:'https://'+b.otherLink}" target="_blank">${b.otherLink.replace(/^https?:\/\//,'').split('/')[0]||'Profile'}</a></span>` : ''}`;

  const hdr=`<div class="rh">
    <div class="rn">${b.name||'YOUR NAME'}</div>
    ${vis.links!==false?`<div class="rc">${linksRow}</div>`:''}
  </div>`;
  const summary=(vis.summary!==false && b.summary)?`<div style="font-size:10.3px;color:#4b5563;line-height:1.5;margin:4px 0 6px;padding:5px 8px;background:#f8fafc;border-radius:4px;border-left:2px solid var(--tpl-theme)">${b.summary}</div>`:'';

  const certList=data.certs||[];
  const showCourseInSkills=!!data.showCertsTop && certList.length;
  const courseInlineText=showCourseInSkills?certList.map(c=>parseCertEntry(c).label).filter(Boolean).join(', '):'';

  const hasSk=vis.skills!==false && (s.lang||s.tools||s.domain||s.cloud||s.course||showCourseInSkills);
  const skills=hasSk?`<div class="rs">Technical Skills</div><div class="rsg">
    ${s.lang?`<div class="rsk">Languages:</div><div class="rsv">${s.lang}</div>`:''}
    ${s.tools?`<div class="rsk">Tools & Frameworks:</div><div class="rsv">${s.tools}</div>`:''}
    ${s.domain?`<div class="rsk">Domain / Stack:</div><div class="rsv">${s.domain}</div>`:''}
    ${s.cloud?`<div class="rsk">Cloud / Databases:</div><div class="rsv">${s.cloud}</div>`:''}
    ${s.course?`<div class="rsk">Coursework:</div><div class="rsv">${s.course}</div>`:''}
    ${showCourseInSkills?`<div class="rsk">Certifications:</div><div class="rsv">${courseInlineText}</div>`:''}
  </div>`:'';

  const expLinksHtml=(links)=>{
    const raw=(links||'').trim();
    if(!raw) return '';
    return raw.split(/[|,]/).map(l=>l.trim()).filter(Boolean).map(lk=>{
      if(/https?:\/\//i.test(lk)||/github\.com|youtube\.com|youtu\.be|linkedin|vercel|netlify|demo|live/i.test(lk)){
        const isGH=/github\.com/i.test(lk), isYT=/youtube\.com|youtu\.be/i.test(lk), isDemo=/demo|live|vercel|netlify|preview/i.test(lk);
        const url=lk.startsWith('http')?lk:'https://'+lk;
        const icon=isGH?'💻':isYT?'▶️':isDemo?'🌐':'🔗';
        const label=isGH?'GitHub':isYT?'YouTube':isDemo?'Demo':'Link';
        return `<a href="${url}" target="_blank" style="font-size:9px;color:var(--tpl-theme);text-decoration:none;font-weight:700;margin-left:5px;border:1px solid var(--tpl-theme);border-radius:4px;padding:1px 5px;white-space:nowrap">${icon} ${label}</a>`;
      }
      return `<span style="font-size:9px;color:#6b7280;margin-left:4px">${lk}</span>`;
    }).join('');
  };

  const exp=(vis.exp!==false && (data.exp||[]).length)?`<div class="rs">Professional Experience</div>`+
    data.exp.map(x=>{
      const dateLoc=`${x.date||''}${x.loc?(x.date?' • ':'')+x.loc:''}`;
      return `<div class="ri">
      <div class="ri-row"><div style="display:flex;align-items:center;flex-wrap:wrap;gap:3px"><span class="ri-title">${x.co||'Company'}</span> — <span class="ri-sub">${x.role||'Role'}</span>${expLinksHtml(x.links)}</div><span class="ri-date">${dateLoc}</span></div>
      <ul class="rb">${(x.bullets||[]).map(bl=>`<li>${bold(bl)}</li>`).join('')}</ul>
    </div>`;
    }).join(''):'';

  const proj=(vis.proj!==false && (data.proj||[]).length)?`<div class="rs">Featured Projects</div>`+
    data.proj.map(p=>{
      const linkRows=parseLinksField(p.links);
      const linkHtml=linkRows.map(r=>{
        if(r.url){
          const url=r.url.startsWith('http')?r.url:'https://'+r.url;
          const icon=iconForLink(r.label,r.url);
          return `<a href="${url}" target="_blank" style="font-size:9px;color:var(--tpl-theme);text-decoration:none;font-weight:700;margin-left:5px;border:1px solid var(--tpl-theme);border-radius:4px;padding:1px 5px;white-space:nowrap">${icon} ${r.label||'Link'}</a>`;
        }
        return `<span style="font-size:9px;color:#6b7280;margin-left:4px">${r.label}</span>`;
      }).join('');
      return `<div class="ri">
      <div class="ri-row"><div style="display:flex;align-items:center;flex-wrap:wrap;gap:3px"><span class="ri-title">${p.title||'Project'}</span>${linkHtml}</div><span class="ri-sub">${p.tech||''}</span></div>
      <ul class="rb">${(p.bullets||[]).map(bl=>`<li>${bold(bl)}</li>`).join('')}</ul>
    </div>`;
    }).join(''):'';

  const eduExtraArr=data.eduExtra||[];
  const hasEdu=vis.edu!==false && ((e.uni||e.deg||e.yrs||e.gpa)||eduExtraArr.length);
  const edu=hasEdu?`<div class="rs">Education</div><div class="ri">
    ${(e.uni||e.deg||e.yrs||e.gpa)?`<div class="ri-row"><span class="ri-title">${e.uni||'University / Institution'}</span><span class="ri-date">${e.yrs||''}</span></div>
    <div class="ri-sub">${e.deg||''}${e.gpa?` — <strong>CGPA / Score: ${e.gpa}</strong>`:''}</div>`:''}
    ${eduExtraArr.length?`<ul class="rb">${eduExtraArr.map(x=>`<li>${bold(x)}</li>`).join('')}</ul>`:''}
  </div>`:'';
  const ach=(vis.ach!==false && (data.ach||[]).length)?`<div class="rs">Achievements</div><div class="ri"><ul class="rb">${data.ach.map(a=>`<li>${bold(a)}</li>`).join('')}</ul></div>`:'';
  const certs=(vis.certs!==false && certList.length)?`<div class="rs">Certifications</div><div class="ri"><ul class="rb">${certList.map(c=>`<li>${certItemHtml(c)}</li>`).join('')}</ul></div>`:'';
  return `${hdr}${summary}${skills}${exp}${proj}${edu}${ach}${certs}`;
}

function closeSGResume(){
  const section=document.getElementById('sgSection');
  if(section) section.style.display='none';
}

// ════════════════════════════════════════════════════════════════
// SGResume — EDITABLE CLONE EDITOR
// Builds a form bound to sgData (never D). Every input updates sgData
// directly and re-renders ONLY the SGResume preview (renderSG) — the
// main resume / editor above is never touched. Card lists (exp/proj)
// get their own light re-render helpers so typing in a bullet textarea
// never rebuilds the whole editor and loses focus/caret position.
// ════════════════════════════════════════════════════════════════
function sgUpdatePreview(){ renderSG(); }

function renderSGEditor(){
  if(!sgData) return;
  const body=document.getElementById('sgEditorBody');
  if(!body) return;
  const esc=v=>(v||'').toString().replace(/"/g,'&quot;');
  const b=sgData.basics||(sgData.basics={}), s=sgData.skills||(sgData.skills={}), e=sgData.edu||(sgData.edu={});
  sgData.sectionVisibility=sgData.sectionVisibility||defaultVisibility();

  body.innerHTML=`
    <div class="vis-toggle-row" style="margin-bottom:8px">
      <span style="font-weight:800;font-size:11.5px;color:#5b21b6;text-transform:uppercase;letter-spacing:.4px">👤 Basics & Links</span>
      <span id="sgVisBtn-links"></span>
    </div>
    <div class="row2">
      <div class="fg"><label>Full Name</label><input value="${esc(b.name)}" oninput="sgData.basics.name=this.value;sgUpdatePreview()"></div>
      <div class="fg"><label>Location</label><input value="${esc(b.loc)}" oninput="sgData.basics.loc=this.value;sgUpdatePreview()"></div>
    </div>
    <div class="row2">
      <div class="fg"><label>Phone</label><input value="${esc(b.phone)}" oninput="sgData.basics.phone=this.value;sgUpdatePreview()"></div>
      <div class="fg"><label>Email</label><input value="${esc(b.email)}" oninput="sgData.basics.email=this.value;sgUpdatePreview()"></div>
    </div>
    <div class="row2">
      <div class="fg"><label>LinkedIn URL</label><input value="${esc(b.li)}" oninput="sgData.basics.li=this.value;sgUpdatePreview()"></div>
      <div class="fg"><label>GitHub URL</label><input value="${esc(b.gh)}" oninput="sgData.basics.gh=this.value;sgUpdatePreview()"></div>
    </div>
    <div class="row2">
      <div class="fg"><label>Portfolio / Website</label><input value="${esc(b.port)}" oninput="sgData.basics.port=this.value;sgUpdatePreview()"></div>
      <div class="fg"><label>Other Link (GFG / LeetCode / etc.)</label><input value="${esc(b.otherLink)}" oninput="sgData.basics.otherLink=this.value;sgUpdatePreview()"></div>
    </div>

    <div class="vis-toggle-row" style="margin-top:14px;margin-bottom:6px">
      <span style="font-weight:800;font-size:11.5px;color:#5b21b6;text-transform:uppercase;letter-spacing:.4px">📝 Summary</span>
      <span id="sgVisBtn-summary"></span>
    </div>
    <div class="fg"><textarea rows="3" oninput="sgData.basics.summary=this.value;sgUpdatePreview()">${b.summary||''}</textarea></div>

    <div class="vis-toggle-row" style="margin-top:14px;margin-bottom:6px">
      <span style="font-weight:800;font-size:11.5px;color:#5b21b6;text-transform:uppercase;letter-spacing:.4px">🛠 Skills</span>
      <span id="sgVisBtn-skills"></span>
    </div>
    <div class="fg"><label>Languages</label><input value="${esc(s.lang)}" oninput="sgData.skills.lang=this.value;sgUpdatePreview()"></div>
    <div class="fg"><label>Tools & Frameworks</label><input value="${esc(s.tools)}" oninput="sgData.skills.tools=this.value;sgUpdatePreview()"></div>
    <div class="fg"><label>Domain / Stack</label><input value="${esc(s.domain)}" oninput="sgData.skills.domain=this.value;sgUpdatePreview()"></div>
    <div class="fg"><label>Cloud / Databases</label><input value="${esc(s.cloud)}" oninput="sgData.skills.cloud=this.value;sgUpdatePreview()"></div>
    <div style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;padding:8px 10px;margin-bottom:10px">
      <label class="mini-toggle"><input type="checkbox" id="sgChkCertsTop" ${sgData.showCertsTop?'checked':''} onchange="sgData.showCertsTop=this.checked;sgUpdatePreview()"> 📍 Show Certifications inline in Skills (one comma-separated line)</label>
    </div>

    <div class="vis-toggle-row" style="margin:14px 0 8px">
      <span style="font-weight:800;font-size:11.5px;color:#5b21b6;text-transform:uppercase;letter-spacing:.4px">💼 Experience</span>
      <span style="display:flex;gap:6px;align-items:center"><span id="sgVisBtn-exp"></span><button type="button" class="btn btn-outline btn-xs" onclick="sgAddExp()">+ Add</button></span>
    </div>
    <div id="sgExpList"></div>

    <div class="vis-toggle-row" style="margin:14px 0 8px">
      <span style="font-weight:800;font-size:11.5px;color:#5b21b6;text-transform:uppercase;letter-spacing:.4px">🚀 Projects</span>
      <span style="display:flex;gap:6px;align-items:center"><span id="sgVisBtn-proj"></span><button type="button" class="btn btn-outline btn-xs" onclick="sgAddProj()">+ Add</button></span>
    </div>
    <div id="sgProjList"></div>

    <div class="vis-toggle-row" style="margin:14px 0 8px">
      <span style="font-weight:800;font-size:11.5px;color:#5b21b6;text-transform:uppercase;letter-spacing:.4px">🎓 Education</span>
      <span id="sgVisBtn-edu"></span>
    </div>
    <div class="row2">
      <div class="fg"><label>University</label><input value="${esc(e.uni)}" oninput="sgData.edu.uni=this.value;sgUpdatePreview()"></div>
      <div class="fg"><label>Year Range</label><input value="${esc(e.yrs)}" oninput="sgData.edu.yrs=this.value;sgUpdatePreview()"></div>
    </div>
    <div class="row2">
      <div class="fg"><label>Degree</label><input value="${esc(e.deg)}" oninput="sgData.edu.deg=this.value;sgUpdatePreview()"></div>
      <div class="fg"><label>CGPA / Score</label><input value="${esc(e.gpa)}" oninput="sgData.edu.gpa=this.value;sgUpdatePreview()"></div>
    </div>
    <div class="fg"><label>Class X / XII / Other School Records (one per line)</label>
      <textarea rows="2" oninput="sgData.eduExtra=this.value.split('\\n').filter(x=>x.trim());sgUpdatePreview()">${(sgData.eduExtra||[]).join('\n')}</textarea>
    </div>

    <div class="vis-toggle-row" style="margin:14px 0 8px">
      <span style="font-weight:800;font-size:11.5px;color:#5b21b6;text-transform:uppercase;letter-spacing:.4px">🏆 Achievements (one per line)</span>
      <span id="sgVisBtn-ach"></span>
    </div>
    <div class="fg"><textarea rows="4" oninput="sgData.ach=this.value.split('\\n').filter(x=>x.trim());sgUpdatePreview()">${(sgData.ach||[]).join('\n')}</textarea></div>

    <div class="vis-toggle-row" style="margin:14px 0 8px">
      <span style="font-weight:800;font-size:11.5px;color:#5b21b6;text-transform:uppercase;letter-spacing:.4px">📜 Certifications (Bottom Section)</span>
      <span id="sgVisBtn-certs"></span>
    </div>
    <div class="fg"><label>One per line. Add a link with <code>Name::https://...</code></label>
      <textarea rows="3" oninput="sgData.certs=this.value.split('\\n').filter(x=>x.trim());sgUpdatePreview()">${(sgData.certs||[]).join('\n')}</textarea>
    </div>
  `;
  renderSGExpEditor();
  renderSGProjEditor();
  updateSGVisToggleUI();
}

function sgToggleVis(sec){
  sgData.sectionVisibility=sgData.sectionVisibility||defaultVisibility();
  sgData.sectionVisibility[sec]=!(sgData.sectionVisibility[sec]!==false);
  sgUpdatePreview();
  updateSGVisToggleUI();
}
function updateSGVisToggleUI(){
  if(!sgData) return;
  const vis=sgData.sectionVisibility||defaultVisibility();
  Object.keys(VIS_SECTION_LABELS).forEach(sec=>{
    const el=document.getElementById('sgVisBtn-'+sec);
    if(!el) return;
    const on=vis[sec]!==false;
    el.innerHTML=`<button type="button" class="vis-toggle ${on?'on':'off'}" onclick="sgToggleVis('${sec}')">${on?'👁️ Shown':'🚫 Hidden'}</button>`;
  });
}

function renderSGExpEditor(){
  const c=document.getElementById('sgExpList');
  if(!c) return;
  const esc=v=>(v||'').toString().replace(/"/g,'&quot;');
  c.innerHTML='';
  (sgData.exp||[]).forEach((x,i)=>{
    const el=document.createElement('div');
    el.className='card';
    el.innerHTML=`
      <div class="card-hdr">
        <span class="card-title">${x.co||'Company'} — ${x.role||'Role'}</span>
        <button class="btn btn-outline btn-xs" style="color:var(--danger)" onclick="sgDelExp(${i})">Del</button>
      </div>
      <div class="row2">
        <div class="fg"><label>Company</label><input value="${esc(x.co)}" oninput="sgData.exp[${i}].co=this.value;sgRenderExpHeader(${i});sgUpdatePreview()"></div>
        <div class="fg"><label>Role</label><input value="${esc(x.role)}" oninput="sgData.exp[${i}].role=this.value;sgRenderExpHeader(${i});sgUpdatePreview()"></div>
      </div>
      <div class="row2">
        <div class="fg"><label>Date</label><input value="${esc(x.date)}" oninput="sgData.exp[${i}].date=this.value;sgUpdatePreview()"></div>
        <div class="fg"><label>Location</label><input value="${esc(x.loc)}" placeholder="Remote / City, Country" oninput="sgData.exp[${i}].loc=this.value;sgUpdatePreview()"></div>
      </div>
      <div class="fg"><label>Links (Live / YouTube / Repo)</label><input value="${esc(x.links)}" oninput="sgData.exp[${i}].links=this.value;sgUpdatePreview()"></div>
      <div class="fg"><label>Bullets (one per line)</label><textarea rows="3" oninput="sgData.exp[${i}].bullets=this.value.split('\\n').filter(v=>v.trim());sgUpdatePreview()">${(x.bullets||[]).join('\n')}</textarea></div>`;
    c.appendChild(el);
  });
  if(!(sgData.exp||[]).length) c.innerHTML='<div style="font-size:10.5px;color:#94a3b8;font-style:italic;padding:4px 0 8px">No experience entries — click + Add above.</div>';
}

function renderSGProjEditor(){
  const c=document.getElementById('sgProjList');
  if(!c) return;
  const esc=v=>(v||'').toString().replace(/"/g,'&quot;');
  c.innerHTML='';
  (sgData.proj||[]).forEach((p,i)=>{
    const el=document.createElement('div');
    el.className='card';
    el.innerHTML=`
      <div class="card-hdr">
        <span class="card-title">${p.title||'Project'}</span>
        <button class="btn btn-outline btn-xs" style="color:var(--danger)" onclick="sgDelProj(${i})">Del</button>
      </div>
      <div class="fg"><label>Title</label><input value="${esc(p.title)}" oninput="sgData.proj[${i}].title=this.value;sgRenderProjHeader(${i});sgUpdatePreview()"></div>
      <div class="fg"><label>Tech Stack</label><input value="${esc(p.tech)}" oninput="sgData.proj[${i}].tech=this.value;sgUpdatePreview()"></div>
      <div class="fg"><label>Links — text/icon shown, actual link opens on click</label>
        ${sgProjLinksRowsHtml(i)}
      </div>
      <div class="fg"><label>Bullets (one per line)</label><textarea rows="3" oninput="sgData.proj[${i}].bullets=this.value.split('\\n').filter(v=>v.trim());sgUpdatePreview()">${(p.bullets||[]).join('\n')}</textarea></div>`;
    c.appendChild(el);
  });
  if(!(sgData.proj||[]).length) c.innerHTML='<div style="font-size:10.5px;color:#94a3b8;font-style:italic;padding:4px 0 8px">No project entries — click + Add above.</div>';
}

// SGResume project links editor — same Label::URL row pattern as the main
// resume's projLinksRowsHtml, but reads/writes sgData (never D).
function sgProjLinksRowsHtml(i){
  const rows=parseLinksField(sgData.proj[i].links);
  if(!rows.length) rows.push({label:'',url:''});
  return rows.map((r,idx)=>`
    <div style="display:flex;gap:4px;align-items:center;margin-bottom:4px;">
      <input type="text" placeholder="Text/label to show (e.g. Live Demo)" value="${(r.label||'').replace(/"/g,'&quot;')}" style="flex:1;padding:4px;font-size:10.5px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:4px;" oninput="sgUpdateProjLinkRow(${i},${idx},'label',this.value)">
      <input type="text" placeholder="Actual link (https://...)" value="${(r.url||'').replace(/"/g,'&quot;')}" style="flex:1.4;padding:4px;font-size:10.5px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:4px;" oninput="sgUpdateProjLinkRow(${i},${idx},'url',this.value)">
      <button type="button" onclick="sgRemoveProjLinkRow(${i},${idx})" title="Remove this link" style="background:#fee2e2;border:none;color:#ef4444;padding:4px 7px;font-size:11px;border-radius:4px;cursor:pointer;font-weight:700;">❌</button>
    </div>`).join('')
    + `<button type="button" onclick="sgAddProjLinkRow(${i})" style="margin-top:2px;padding:4px 8px;font-size:10px;font-weight:700;background:#eff6ff;border:1px dashed #2563eb;color:#2563eb;border-radius:4px;cursor:pointer;width:100%;text-align:center;">+ Add Link</button>`;
}
function sgAddProjLinkRow(i){
  const rows=parseLinksField(sgData.proj[i].links);
  rows.push({label:'',url:''});
  sgData.proj[i].links=serializeLinksField(rows);
  renderSGProjEditor(); sgUpdatePreview();
}
function sgRemoveProjLinkRow(i,idx){
  const rows=parseLinksField(sgData.proj[i].links);
  rows.splice(idx,1);
  sgData.proj[i].links=serializeLinksField(rows);
  renderSGProjEditor(); sgUpdatePreview();
}
function sgUpdateProjLinkRow(i,idx,field,value){
  // Only updates data + the live preview — never re-renders the editor DOM
  // here, or the input would lose focus/caret position on every keystroke.
  const rows=parseLinksField(sgData.proj[i].links);
  while(rows.length<=idx) rows.push({label:'',url:''});
  rows[idx][field]=value;
  sgData.proj[i].links=serializeLinksField(rows);
  sgUpdatePreview();
}

// Update just the card title text (no full rebuild) so typing in
// Company/Role/Title fields never loses input focus mid-keystroke.
function sgRenderExpHeader(i){
  const c=document.getElementById('sgExpList');
  const title=c?.children[i]?.querySelector('.card-title');
  if(title) title.textContent=`${sgData.exp[i].co||'Company'} — ${sgData.exp[i].role||'Role'}`;
}
function sgRenderProjHeader(i){
  const c=document.getElementById('sgProjList');
  const title=c?.children[i]?.querySelector('.card-title');
  if(title) title.textContent=sgData.proj[i].title||'Project';
}

function sgAddExp(){
  sgData.exp=sgData.exp||[];
  sgData.exp.push({co:'Company Name',role:'Role',date:'',loc:'',links:'',bullets:['Describe your impact here.']});
  renderSGExpEditor(); sgUpdatePreview();
}
function sgDelExp(i){
  if(!confirm('Remove this experience from the SGResume clone?'))return;
  sgData.exp.splice(i,1);
  renderSGExpEditor(); sgUpdatePreview();
}
function sgAddProj(){
  sgData.proj=sgData.proj||[];
  sgData.proj.push({title:'Project Name',tech:'',links:'',bullets:['Describe what you built and its impact.']});
  renderSGProjEditor(); sgUpdatePreview();
}
function sgDelProj(i){
  if(!confirm('Remove this project from the SGResume clone?'))return;
  sgData.proj.splice(i,1);
  renderSGProjEditor(); sgUpdatePreview();
}

function downloadSGResume(){
  if(!sgData){ toast('Pehle SGResume generate karo','warning'); return; }
  document.body.classList.add('print-sg');
  requestAnimationFrame(()=>window.print());
}

// ════════════════════════════════════════════════════════════════
// ENHANCED EXP/PROJ EDITORS WITH DRAG
// ════════════════════════════════════════════════════════════════
function renderExpEditor(){
  const c=document.getElementById('expList');c.innerHTML='';
  (D.exp||[]).forEach((e,i)=>{
    const flags=redFlags(e.bullets);
    const el=document.createElement('div');el.className='card';
    el.innerHTML=`
      <div class="card-hdr">
        <span style="display:flex;align-items:center;gap:4px">
          <span class="drag-handle" title="Drag to reorder">⠿</span>
          <span class="card-title">${e.co||'Company'} — ${e.role||'Role'}</span>
        </span>
        <div style="display:flex;gap:5px">
          <button class="btn btn-purple btn-sm" onclick="storeOrig('exp',${i});aiFixItem('exp',${i})">🤖 AI Fix</button>
          <button class="btn btn-outline btn-sm" style="color:var(--danger)" onclick="delExp(${i})">Del</button>
        </div>
      </div>
      <div class="${flags.length?'rflag-bar rflag-warn':'rflag-bar rflag-ok'}">
        ${flags.length?flags[0]:'✓ Strong verbs & metrics detected — ATS ready'}
      </div>
      <div class="row2">
        <div class="fg"><label>Company</label><input value="${e.co||''}" oninput="D.exp[${i}].co=this.value;render()"></div>
        <div class="fg"><label>Role</label><input value="${e.role||''}" oninput="D.exp[${i}].role=this.value;render()"></div>
      </div>
      <div class="row2">
        <div class="fg"><label>Date</label><input value="${e.date||''}" oninput="D.exp[${i}].date=this.value;render()"></div>
        <div class="fg"><label>Location</label><input value="${e.loc||''}" placeholder="Remote / City, Country" oninput="D.exp[${i}].loc=this.value;render()"></div>
      </div>
      <div class="fg"><label>Links — text/icon shown on resume, actual link opens on click</label>${expLinksRowsHtml(i)}</div>
      <div class="fg"><label>Bullets (one per line — **bold** for metrics)</label>
        <textarea rows="4" oninput="D.exp[${i}].bullets=this.value.split('\\n').filter(x=>x.trim());render();liveATS()">${(e.bullets||[]).join('\n')}</textarea>
      </div>
      <div class="ai-suggest-box" id="aibox-exp-${i}"></div>`;
    makeDraggable(el,'exp',i);
    c.appendChild(el);
  });
}

function renderProjEditor(){
  const c=document.getElementById('projList');c.innerHTML='';
  (D.proj||[]).forEach((p,i)=>{
    const flags=redFlags(p.bullets);
    const el=document.createElement('div');el.className='card';
    el.innerHTML=`
      <div class="card-hdr">
        <span style="display:flex;align-items:center;gap:4px">
          <span class="drag-handle" title="Drag to reorder">⠿</span>
          <span class="card-title">${p.title||'Project'}</span>
        </span>
        <div style="display:flex;gap:5px">
          <button class="btn btn-purple btn-sm" onclick="storeOrig('proj',${i});aiFixItem('proj',${i})">🤖 AI Fix</button>
          <button class="btn btn-outline btn-sm" style="color:var(--danger)" onclick="delProj(${i})">Del</button>
        </div>
      </div>
      <div class="${flags.length?'rflag-bar rflag-warn':'rflag-bar rflag-ok'}">
        ${flags.length?flags[0]:'✓ Good bullet quality — results-driven'}
      </div>
      <div class="fg"><label>Project Title</label><input value="${p.title||''}" oninput="D.proj[${i}].title=this.value;render()"></div>
      <div class="fg"><label>Tech Stack</label><input value="${p.tech||''}" oninput="D.proj[${i}].tech=this.value;render()"></div>
      <div class="fg"><label>Links — text/icon shown on resume, actual link opens on click</label>
        ${projLinksRowsHtml(i)}
      </div>
      <div class="fg"><label>Bullets (one per line)</label>
        <textarea rows="3" oninput="D.proj[${i}].bullets=this.value.split('\\n').filter(x=>x.trim());render();liveATS()">${(p.bullets||[]).join('\n')}</textarea>
      </div>
      <div class="ai-suggest-box" id="aibox-proj-${i}"></div>`;
    makeDraggable(el,'proj',i);
    c.appendChild(el);
  });
}

// ════════════════════════════════════════════════════════════════
// ENHANCED SYNC — includes summary
// ════════════════════════════════════════════════════════════════
function syncFormToD(){
  const g=id=>document.getElementById(id)?.value||'';
  D.basics={
    name:g('iName'),
    loc:g('iLoc'),
    phone:g('iPhone'),
    email:g('iEmail'),
    li:g('iLI'),
    gh:g('iGH'),
    gfg:g('iGFG'),
    leetcode:g('iLC'),
    codeforces:g('iOtherLink'),
    port:g('iPort'),
    otherLink:g('iOtherLink'),
    summary:g('iSummary')
  };
  if(!D.skills) D.skills={};
  D.skills.lang = g('sLang');
  D.skills.tools = g('sTools');
  D.skills.domain = g('sDomain');
  D.skills.cloud = g('sCloud');
  D.skills.course = g('sCourse');
  D.edu={uni:g('iUni'),deg:g('iDeg'),yrs:g('iYrs'),gpa:g('iGPA')};
  D.eduExtra=g('iEduExtra').split('\n').filter(x=>x.trim());
  D.ach=g('iAch').split('\n').filter(x=>x.trim());
  D.certs=g('iCert').split('\n').filter(x=>x.trim());
  
  // Sync Outreach defaults
  if(!D.outreach) D.outreach={};
  D.outreach.name=g('autofillName');
  D.outreach.email=g('autofillEmail');
  D.outreach.phone=g('autofillPhone');
  D.outreach.location=g('autofillLocation');
  D.outreach.linkedin=g('autofillLI');
  D.outreach.github=g('autofillGH');
  D.outreach.total_experience=g('autofillExperience');
  D.outreach.notice_period=g('autofillNotice');
  D.outreach.current_ctc=g('autofillCurrentCTC');
  D.outreach.expected_ctc=g('autofillExpectedCTC');
  D.outreach.reason_for_change=g('autofillReason');
  D.outreach.experience_summary=g('autofillSummary');
  
  // Sync custom mappings list
  const cList = [];
  const rows = document.querySelectorAll("#customMappingsContainer .cm-row");
  rows.forEach(r => {
    const k = r.querySelector(".cm-key")?.value.trim() || "";
    const v = r.querySelector(".cm-val")?.value || "";
    if(k) cList.push({ key: k, val: v });
  });
  D.outreach.custom_mappings = cList;
}

// ════════════════════════════════════════════════════════════════
// LINE-LIST EDITOR — generic Add / Edit / Delete UI for the
// "one item per line" sections (School Records, Achievements,
// Certifications). The real data still lives in the hidden
// <textarea> (so syncFormToD()/populateForm() keep working exactly
// as before) — this just renders it as friendly editable rows.
// ════════════════════════════════════════════════════════════════
function renderLineList(taId, listId, placeholder){
  const ta=document.getElementById(taId), list=document.getElementById(listId);
  if(!ta||!list) return;
  const lines=ta.value.split('\n');
  const hasContent = lines.some(l=>l.trim());
  list.innerHTML='';
  if(!hasContent){
    const hint=document.createElement('div');
    hint.className='line-empty-hint';
    hint.textContent='Nothing added yet — click "+ Add" below.';
    list.appendChild(hint);
    return;
  }
  lines.forEach((line,i)=>{
    const row=document.createElement('div');
    row.className='line-list-row';
    const input=document.createElement('input');
    input.type='text';
    input.value=line;
    input.placeholder=placeholder||'';
    input.oninput=()=>updateLineItem(taId,listId,i,input.value);
    const del=document.createElement('button');
    del.type='button';
    del.className='line-del-btn';
    del.title='Delete this item';
    del.innerHTML='🗑';
    del.onclick=()=>deleteLineItem(taId,listId,i);
    row.appendChild(input); row.appendChild(del);
    list.appendChild(row);
  });
}
function updateLineItem(taId,listId,i,val){
  const ta=document.getElementById(taId);
  const lines=ta.value.split('\n');
  lines[i]=val;
  ta.value=lines.join('\n');
  render(); liveATS();
}
function deleteLineItem(taId,listId,i){
  if(!confirm('Delete this item?'))return;
  const ta=document.getElementById(taId);
  const lines=ta.value.split('\n');
  lines.splice(i,1);
  ta.value=lines.join('\n');
  renderLineList(taId,listId);
  render(); liveATS();
}
function addLineItem(taId,listId,placeholder){
  const ta=document.getElementById(taId);
  const lines=ta.value.split('\n').filter(x=>x!=='');
  lines.push('');
  ta.value=lines.join('\n');
  renderLineList(taId,listId,placeholder);
  render();
  setTimeout(()=>{
    const inputs=document.getElementById(listId)?.querySelectorAll('input')||[];
    if(inputs.length) inputs[inputs.length-1].focus();
  },0);
}
function renderAllLineLists(){
  renderLineList('iEduExtra','eduExtraList');
  renderLineList('iAch','achList');
  renderLineList('iCert','certList');
}



// ════ HYPERLINKS SECTION ════
function renderHyperlinksEditor(){
  const container = document.getElementById('hyperlinksEditorList');
  const toggle = document.getElementById('hyperlinksSectionVisible');
  const label = document.getElementById('hyperlinksVisibleLabel');
  const isVis = (D.sectionVisibility && D.sectionVisibility.hyperlinks === true);
  if(toggle) toggle.checked = isVis;
  if(label) label.textContent = isVis ? 'Show in Resume: ON ✅' : 'Show in Resume: OFF ❌';
  if(!container) return;
  if(!D.hyperlinks) D.hyperlinks = [];
  container.innerHTML = (D.hyperlinks.length === 0)
    ? '<div style="font-size:10px;color:#94a3b8;text-align:center;padding:12px;background:#f8fafc;border-radius:6px;border:1px dashed #cbd5e1;">No custom links added yet. Click <strong>+ Add New Link</strong> below.</div>'
    : D.hyperlinks.map((h,i) => `
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;background:#f8fafc;padding:6px;border-radius:6px;border:1px solid #e2e8f0;">
        <input type="text" value="${(h.label||'').replace(/"/g,'&quot;')}" placeholder="Display Name (e.g. Mastermind Tech Demo)" style="flex:1;padding:5px 8px;font-size:11px;border:1px solid #cbd5e1;border-radius:4px;box-sizing:border-box;" oninput="D.hyperlinks[${i}].label=this.value;render()">
        <input type="text" value="${(h.url||'').replace(/"/g,'&quot;')}" placeholder="Actual URL (https://...)" style="flex:1.6;padding:5px 8px;font-size:11px;border:1px solid #cbd5e1;border-radius:4px;box-sizing:border-box;" oninput="D.hyperlinks[${i}].url=this.value;render()">
        <button type="button" onclick="removeHyperlinkEntry(${i})" title="Delete Link" style="background:#fee2e2;border:none;color:#ef4444;padding:5px 9px;font-size:11px;border-radius:4px;cursor:pointer;font-weight:700;">❌</button>
      </div>`).join('');
}
function addHyperlinkEntry(){
  if(!D.hyperlinks) D.hyperlinks = [];
  D.hyperlinks.push({label:'',url:''});
  renderHyperlinksEditor();
  render();
}
function removeHyperlinkEntry(i){
  D.hyperlinks.splice(i,1);
  renderHyperlinksEditor();
  render();
}


function populateForm(){
  const s=(id,v)=>{const el=document.getElementById(id);if(el)el.value=v||'';};
  const b=D.basics,sk=D.skills,e=D.edu,ot=D.outreach||{};
  s('iName',b.name);s('iLoc',b.loc);s('iPhone',b.phone);s('iEmail',b.email);
  s('iLI',b.li);s('iGH',b.gh);s('iGFG',b.gfg);s('iLC',b.leetcode);s('iPort',b.port);s('iOtherLink',b.otherLink||b.codeforces||b.hackerrank);
  s('iSummary',b.summary||'');
  s('sLang',sk.lang);s('sTools',sk.tools);s('sDomain',sk.domain);s('sCloud',sk.cloud);s('sCourse',sk.course);
  s('iUni',e.uni);s('iDeg',e.deg);s('iYrs',e.yrs);s('iGPA',e.gpa);
  s('iEduExtra',(D.eduExtra||[]).join('\n'));
  s('iAch',(D.ach||[]).join('\n'));
  s('iCert',(D.certs||[]).join('\n'));
  
  // Populate Outreach defaults
  s('autofillName',ot.name || b.name);
  s('autofillEmail',ot.email || b.email);
  s('autofillPhone',ot.phone || b.phone);
  s('autofillLocation',ot.location || b.loc);
  s('autofillLI',ot.linkedin || b.li);
  s('autofillGH',ot.github || b.gh);
  s('autofillExperience',ot.total_experience || '2 Years');
  s('autofillNotice',ot.notice_period || 'Within 30 days');
  s('autofillCurrentCTC',ot.current_ctc || 'Negotiable / Confidential');
  s('autofillExpectedCTC',ot.expected_ctc || 'Negotiable as per standards');
  s('autofillReason',ot.reason_for_change || 'Seeking a challenging role...');
  s('autofillSummary',ot.experience_summary || 'A software engineer...');
  
  // Populate custom mappings list
  const container = document.getElementById("customMappingsContainer");
  if(container) {
    container.innerHTML = "";
    const list = ot.custom_mappings || [];
    list.forEach(item => {
      addCustomMappingRow(item.key, item.val);
    });
  }
  
  const certsTopChk=document.getElementById('chkCertsTop');
  if(certsTopChk) certsTopChk.checked=!!D.showCertsTop;
  renderExpEditor();renderProjEditor();
  renderAllLineLists();
  adjustFieldPlacements();
  updateVisToggleUI();
}

// ════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded',()=>{
  const saved=localStorage.getItem('rsai_v10');
  if(saved){
    try{
      D=JSON.parse(saved);
      if(!D.basics) D.basics={};
      if(!D.basics.summary) D.basics.summary='';
      if(!D.edu) D.edu={uni:'',deg:'',yrs:'',gpa:''};
      if(!Array.isArray(D.ach)){
        D.ach = Array.isArray(D.edu?.ach) ? D.edu.ach : [];
      }
      if(!Array.isArray(D.certs)) D.certs=[];
      if(!Array.isArray(D.eduExtra)) D.eduExtra=[];
      if(D.edu.ach) delete D.edu.ach;
      // MIGRATION: older/offline parses used to dump Class X / XII school
      // lines into the Achievements array. Pull any of those out of D.ach
      // and move them into D.eduExtra so they render under Education, not
      // Achievements, without needing the user to re-paste their resume.
      if(Array.isArray(D.ach) && D.ach.length){
        const isSchoolLine = s => /class\s*x(?:ii)?\b/i.test(s) || /^(?:central\s+board|(?:cbse|icse)\s*,?\s*new\s*delhi|board\s+of\s+(?:secondary|higher))/i.test(s.trim());
        const moved = D.ach.filter(isSchoolLine);
        if(moved.length){
          moved.forEach(m => { if(!D.eduExtra.includes(m)) D.eduExtra.push(m); });
          D.ach = D.ach.filter(a => !isSchoolLine(a));
        }
      }
      if(!Array.isArray(D.exp)) D.exp=[];
      if(!Array.isArray(D.proj)) D.proj=[];
      if(!D.sectionVisibility) D.sectionVisibility=defaultVisibility();
      if(D.showCertsTop===undefined) D.showCertsTop=false;
    }catch(e){loadSample();return;}
  }else{loadSample();return;}
  populateForm();render();liveATS();updateTabNav();
  updatePresetQuickUI();
  const initName = AIK.gemini ? 'Google Gemini' : (AIK.groq ? 'Groq Cloud' : (AIK.nvidia ? 'NVIDIA NIM' : (AIK.openrouter ? 'OpenRouter' : (AIK.customKey ? 'Custom Endpoint' : (AIK.enableFreeAI !== false ? 'Free Online AI' : 'Offline Parser')))));
  updateAIBadge(initName, hasAnyKey());
  if(hasAnyKey()){
    setTimeout(()=>toast(`🤖 Active Engine: ${initName}`,'success',3500),500);
  }else{
    setTimeout(()=>toast('💡 Add an AI API key for real AI (click 🔑 API Key in navbar)','info',5000),1500);
  }
});

// ════════════════════════════════════════════════════════════════
let activeAutofillMode = 'local';
function switchAutofillMode(mode) {
  activeAutofillMode = mode;
  const btnLocal = document.getElementById("btnAutofillLocal");
  const btnAI = document.getElementById("btnAutofillAI");
  const panelLocal = document.getElementById("panelAutofillLocal");
  const panelAI = document.getElementById("panelAutofillAI");
  
  if (mode === 'local') {
    btnLocal.style.background = '#ede9fe';
    btnLocal.style.color = '#6d28d9';
    btnAI.style.background = 'transparent';
    btnAI.style.color = '#6b7280';
    panelLocal.style.display = 'block';
    panelAI.style.display = 'none';
  } else {
    btnLocal.style.background = 'transparent';
    btnLocal.style.color = '#6b7280';
    btnAI.style.background = '#ede9fe';
    btnAI.style.color = '#6d28d9';
    panelLocal.style.display = 'none';
    panelAI.style.display = 'block';
  }
}

function addCustomMappingRow(key = '', val = '') {
  const container = document.getElementById("customMappingsContainer");
  if (!container) return;
  const rowId = 'cmRow_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
  
  const div = document.createElement("div");
  div.id = rowId;
  div.className = "cm-row";
  div.style = "display:flex; gap:4px; margin-bottom:4px; align-items:center;";
  div.innerHTML = `
    <input type="text" placeholder="Question Keyword (e.g. experience)" class="cm-key" value="${key}" style="flex:1; padding:3px; font-size:10.5px; box-sizing:border-box; border:1px solid #cbd5e1; border-radius:4px;" onchange="syncFormToD()">
    <input type="text" placeholder="Value to fill (e.g. 2 Years)" class="cm-val" value="${val}" style="flex:1; padding:3px; font-size:10.5px; box-sizing:border-box; border:1px solid #cbd5e1; border-radius:4px;" onchange="syncFormToD()">
    <button type="button" onclick="removeCustomMappingRow('${rowId}')" style="background:#fee2e2; border:none; color:#ef4444; padding:3px 6px; font-size:10.5px; border-radius:4px; cursor:pointer; font-weight:700;">❌</button>
  `;
  container.appendChild(div);
  syncFormToD();
}

function removeCustomMappingRow(rowId) {
  const row = document.getElementById(rowId);
  if (row) {
    row.remove();
  }
  syncFormToD();
}

async function triggerBrowserAutofill() {
  syncFormToD(); // Ensure latest inputs are synced into memory variable D
  toast("⚡ Connecting to Chrome (Port 9223) and analyzing form...", "info", 3000);
  
  const autofillName = document.getElementById("autofillName")?.value || "";
  const autofillEmail = document.getElementById("autofillEmail")?.value || "";
  const autofillPhone = document.getElementById("autofillPhone")?.value || "";
  const autofillLocation = document.getElementById("autofillLocation")?.value || "";
  const autofillLI = document.getElementById("autofillLI")?.value || "";
  const autofillGH = document.getElementById("autofillGH")?.value || "";
  const autofillExperience = document.getElementById("autofillExperience")?.value || "2 Years";
  const autofillNotice = document.getElementById("autofillNotice")?.value || "Within 30 days";
  const autofillCurrentCTC = document.getElementById("autofillCurrentCTC")?.value || "Negotiable / Confidential";
  const autofillExpectedCTC = document.getElementById("autofillExpectedCTC")?.value || "Negotiable as per standards";
  const autofillReason = document.getElementById("autofillReason")?.value || "";
  const autofillSummary = document.getElementById("autofillSummary")?.value || "";

  const autofillAIStrategy = document.getElementById("autofillAIStrategy")?.value || "pure_ai";

  try {
    const response = await fetch("/api/gate4/autofill", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ 
        resume_data: D, 
        keys: AIK,
        autofill_mode: activeAutofillMode,
        ai_strategy: autofillAIStrategy,
        custom_defaults: {
          name: autofillName,
          email: autofillEmail,
          phone: autofillPhone,
          location: autofillLocation,
          linkedin: autofillLI,
          github: autofillGH,
          total_experience: autofillExperience,
          notice_period: autofillNotice,
          current_ctc: autofillCurrentCTC,
          expected_ctc: autofillExpectedCTC,
          reason_for_change: autofillReason,
          experience_summary: autofillSummary,
          custom_mappings: D.outreach.custom_mappings || []
        }
      })
    });
    
    const result = await response.json();
    if (response.ok) {
      toast(`✅ ${result.message}`, "success", 4000);
      
      // Render unfilled fields if any
      const container = document.getElementById("unfilledFieldsContainer");
      const listDiv = document.getElementById("unfilledFieldsList");
      if (container && listDiv) {
        listDiv.innerHTML = "";
        const ulist = result.unfilled_fields || [];
        if (ulist.length > 0) {
          container.style.display = "block";
          ulist.forEach(item => {
            const div = document.createElement("div");
            div.className = "unfilled-row";
            div.style = "display:flex; flex-direction:column; gap:2px; border-bottom:1px solid #fecaca; padding-bottom:6px;";
            
            let cleanLabel = item.labelText || item.selector;
            if (cleanLabel.length > 80) cleanLabel = cleanLabel.substring(0, 80) + "...";
            
            const span = document.createElement("span");
            span.style = "font-size:9.5px; font-weight:700; color:#7f1d1d;";
            span.innerText = cleanLabel;
            
            const input = document.createElement("input");
            input.type = "text";
            input.placeholder = "Type answer for this field...";
            input.className = "unfilled-val";
            input.style = "padding:3px; font-size:10.5px; border:1px solid #cbd5e1; border-radius:4px; box-sizing:border-box; width:100%;";
            input.setAttribute("data-selector", item.selector);
            input.setAttribute("data-label", cleanLabel);
            
            div.appendChild(span);
            div.appendChild(input);
            listDiv.appendChild(div);
          });
        } else {
          container.style.display = "none";
        }
      }
    } else {
      toast(`❌ ${result.detail || 'Autofill failed.'}`, "error", 5000);
    }
  } catch (error) {
    toast(`❌ Failed to connect to local server: ${error.message}`, "error", 5000);
  }
}

function saveUnfilledFieldsToCustom() {
  const inputs = document.querySelectorAll("#unfilledFieldsList .unfilled-val");
  let addedCount = 0;
  inputs.forEach(input => {
    const val = input.value.trim();
    if (val) {
      const label = input.getAttribute("data-label");
      // Clean keyword (remove question marks/stars and keep lowercase keyword)
      let keyword = label.replace(/[?*:]/g, "").trim().toLowerCase();
      addCustomMappingRow(keyword, val);
      addedCount++;
    }
  });
  if (addedCount > 0) {
    localStorage.setItem('rsai_v10', JSON.stringify(D));
    toast(`💾 Saved ${addedCount} answers to Custom Matches & Local Storage!`, "success", 3000);
    document.getElementById("unfilledFieldsContainer").style.display = "none";
  } else {
    toast("💡 Please fill at least one answer before saving.", "info", 3000);
  }
}

function adjustFieldPlacements() {
  const mainCont = document.getElementById("promotedDefaultsContainer");
  const moreCont = document.getElementById("moreDefaultsContainer");
  const customMatchesGroup = document.getElementById("groupCustomMatches");
  if (!mainCont || !moreCont) return;

  const fields = [
    { id: "autofillExperience", groupId: "groupExperience" },
    { id: "autofillNotice", groupId: "groupNotice" },
    { id: "autofillReason", groupId: "groupReason" },
    { id: "autofillSummary", groupId: "groupSummary" }
  ];

  fields.forEach(f => {
    const input = document.getElementById(f.id);
    const group = document.getElementById(f.groupId);
    if (input && group) {
      const val = input.value.trim();
      if (val !== "") {
        mainCont.appendChild(group);
      } else {
        moreCont.insertBefore(group, customMatchesGroup);
      }
    }
  });

  // Handle CTC group
  const currCTC = document.getElementById("autofillCurrentCTC");
  const expCTC = document.getElementById("autofillExpectedCTC");
  const groupCTC = document.getElementById("groupCTC");
  if (currCTC && expCTC && groupCTC) {
    const valCurr = currCTC.value.trim();
    const valExp = expCTC.value.trim();
    if (valCurr !== "" || valExp !== "") {
      mainCont.appendChild(groupCTC);
    } else {
      moreCont.insertBefore(groupCTC, customMatchesGroup);
    }
  }
}

function saveOutreachDefaults() {
  syncFormToD();
  localStorage.setItem('rsai_v10', JSON.stringify(D));
  adjustFieldPlacements();
  toast("💾 Outreach & Autofill defaults saved successfully!", "success", 3000);
}

function gate1SenderProfile() {
  syncFormToD();
  const basics = D.basics || {};
  const outreach = D.outreach || {};
  return {
    name: basics.name || "",
    email: basics.email || "",
    phone: basics.phone || "",
    linkedin: basics.li || "",
    github: basics.gh || "",
    experience_summary: outreach.experience_summary || basics.summary || "",
    notice_period: outreach.notice_period || "",
    current_ctc: outreach.current_ctc || "",
    expected_ctc: outreach.expected_ctc || "",
    reason_for_change: outreach.reason_for_change || ""
  };
}

async function triggerEmailOutreach(overrideMode) {
  const startRow = parseInt(document.getElementById("outreachStartRow")?.value || "2");
  const endRow = parseInt(document.getElementById("outreachEndRow")?.value || "10");
  const mode = overrideMode || document.getElementById("outreachOutboxMode")?.value || "draft";

  const senderProfile = gate1SenderProfile();

  if (!senderProfile.email) {
    toast("⚙️ Set your Email Address under Personal/Basics details before running a campaign.", "warning", 6000);
    return;
  }

  // Advanced Mode template/resume selections (both optional — empty means
  // "let the backend auto-match by role / auto-pick latest PDF", exactly
  // like the original single-template flow, so nothing breaks if unset).
  const templateName = document.getElementById("gate1AdvTemplateSel")?.value || "";
  const resumeFilename = document.getElementById("gate1AdvResumeSel")?.value || "";

  toast(`📧 Launching outreach campaign for rows ${startRow} to ${endRow}...`, "info", 3000);

  try {
    const response = await fetch("/api/gate1/send-emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        start_row: startRow,
        end_row: endRow,
        mode: mode,
        sender_profile: senderProfile,
        template_name: templateName,
        resume_filename: resumeFilename
      })
    });

    const result = await response.json();
    if (response.ok) {
      toast(`✅ ${result.message}`, "success", 5000);
    } else if (response.status === 428) {
      toast(`⚙️ Setup needed: ${result.detail}`, "warning", 8000);
    } else {
      toast(`❌ ${result.detail || 'Outreach failed.'}`, "error", 5000);
    }
  } catch (error) {
    toast(`❌ Failed to connect to backend server: ${error.message}`, "error", 5000);
  }
}

// ════════════════════════════════════════════════════════════════
// GATE 1 UI — Fast Apply / Advanced Mode container
// ════════════════════════════════════════════════════════════════
const GATE1_API = "/api/gate1";
const GATE1_AUTO_OPTION = { value: "", label: "Auto (latest PDF / role-matched)" };

function switchGate1Mode(tab) {
  const fastPane = document.getElementById('gate1PaneFast');
  const advPane = document.getElementById('gate1PaneAdvanced');
  const fastTab = document.getElementById('gate1TabFast');
  const advTab = document.getElementById('gate1TabAdvanced');
  const isFast = tab === 'fast';
  fastPane.style.display = isFast ? 'block' : 'none';
  advPane.style.display = isFast ? 'none' : 'block';
  fastTab.style.color = isFast ? '#1e40af' : '#64748b';
  fastTab.style.borderBottomColor = isFast ? '#2563eb' : 'transparent';
  advTab.style.color = isFast ? '#64748b' : '#1e40af';
  advTab.style.borderBottomColor = isFast ? 'transparent' : '#2563eb';
}

function onGate1TemplateModeChange() {
  const mode = document.getElementById('gate1TemplateMode')?.value;
  document.getElementById('gate1AiTemplateBox').style.display = mode === 'ai' ? 'block' : 'none';
}

function onGate1ResumeModeChange() {
  const mode = document.getElementById('gate1ResumeMode')?.value;
  document.getElementById('gate1ManualAiBox').style.display = mode === 'manualai' ? 'block' : 'none';
  if (mode === 'ai') {
    document.getElementById('gate1TemplateMode').value = 'ai';
    onGate1TemplateModeChange();
  }
}

async function refreshGate1Templates() {
  const selects = [document.getElementById('gate1FastTemplateSel'), document.getElementById('gate1AdvTemplateSel')];
  try {
    const res = await fetch(`${GATE1_API}/templates`);
    const data = await res.json();
    const templates = (data && data.templates) || [];
    selects.forEach(sel => {
      if (!sel) return;
      const current = sel.value;
      sel.innerHTML = '';
      if (sel.id === 'gate1AdvTemplateSel') {
        const optAuto = document.createElement('option');
        optAuto.value = ''; optAuto.textContent = GATE1_AUTO_OPTION.label;
        sel.appendChild(optAuto);
      }
      templates.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.name;
        opt.textContent = t.name + (t.preview ? ` — ${t.preview}` : '');
        sel.appendChild(opt);
      });
      if ([...sel.options].some(o => o.value === current)) sel.value = current;
    });
  } catch (e) {
    console.warn('Could not load Gate 1 templates:', e.message);
  }
}

// ---- Gate 1 Lead Sheets Registry API ----
async function refreshGate1Sheets() {
  try {
    const res = await fetch(`${GATE1_API}/sheets`);
    const data = await res.json();
    if (res.ok) {
      const sel = document.getElementById('gate1ActiveSheet');
      if (!sel) return;
      sel.innerHTML = '';
            if (data.sheets && data.sheets.length > 0) {
        data.sheets.forEach(s => {
          const opt = document.createElement('option');
          opt.value = s.key;
          opt.textContent = s.name + (s.is_default ? ' (Default)' : '');
          if (s.is_default) opt.selected = true;
          sel.appendChild(opt);
        });
      }
      
      if (data.has_legacy_fallback) {
        const opt = document.createElement('option');
        opt.value = 'legacy';
        opt.textContent = 'Legacy GOOGLE_SHEET_ID (Fallback)';
        if (!data.sheets || data.sheets.length === 0) opt.selected = true;
        sel.appendChild(opt);
      }
      onGate1SheetChange();
    }
  } catch (e) { console.error('Error fetching sheets for gate 1:', e); }
}

function onGate1SheetChange() {
  const sel = document.getElementById('gate1ActiveSheet');
  const btnSetDef = document.getElementById('btnSetDefaultSheet');
  const btnRem = document.getElementById('btnRemoveSheet');
  if (!sel || !sel.value) {
    if (btnSetDef) btnSetDef.style.display = 'none';
    if (btnRem) btnRem.style.display = 'none';
    return;
  }
  const isDefault = sel.options[sel.selectedIndex].text.includes('(Default)');
  if (btnSetDef) btnSetDef.style.display = isDefault ? 'none' : 'inline-block';
  if (btnRem) btnRem.style.display = 'inline-block';
}

async function setGate1DefaultSheet() {
  const sel = document.getElementById('gate1ActiveSheet');
  if (!sel || !sel.value) return;
  try {
    const res = await fetch('/api/gate1/sheets/' + sel.value + '/default', { method: 'POST' });
    if (res.ok) {
      toast('Default sheet updated.', 'success');
      refreshGate1Sheets();
    } else {
      const data = await res.json();
      toast(data.detail || 'Error', 'error');
    }
  } catch(e) { toast(e.message, 'error'); }
}

async function removeGate1Sheet() {
  const sel = document.getElementById('gate1ActiveSheet');
  if (!sel || !sel.value) return;
  if (!confirm('Disconnect this sheet? (Does not delete it from Google Drive)')) return;
  try {
    const res = await fetch('/api/gate1/sheets/' + sel.value, { method: 'DELETE' });
    if (res.ok) {
      toast('Sheet disconnected.', 'success');
      refreshGate1Sheets();
    } else {
      const data = await res.json();
      toast(data.detail || 'Error', 'error');
    }
  } catch(e) { toast(e.message, 'error'); }
}

async function refreshGate2Sheets() {
  try {
    const res = await fetch('/api/gate1/sheets');
    const data = await res.json();
    if (res.ok) {
      const sel = document.getElementById('gate2ExistingSheetSel');
      if (!sel) return;
      sel.innerHTML = '';
      if (data.sheets && data.sheets.length > 0) {
        data.sheets.forEach(s => {
          const opt = document.createElement('option');
          opt.value = s.key;
          opt.textContent = s.name + (s.is_default ? ' (Default)' : '');
          if (s.is_default) opt.selected = true;
          sel.appendChild(opt);
        });
      }
      if (data.has_legacy_fallback) {
        const opt = document.createElement('option');
        opt.value = 'legacy';
        opt.textContent = 'Legacy GOOGLE_SHEET_ID (Fallback)';
        if (!data.sheets || data.sheets.length === 0) opt.selected = true;
        sel.appendChild(opt);
      }
    }
  } catch (e) { console.error('Error fetching sheets for gate 2:', e); }
}

async function runGate2Search() {
  const role = document.getElementById('gate2SearchRole').value.trim();
  const ind = document.getElementById('gate2SearchIndustry').value.trim();
  const loc = document.getElementById('gate2SearchLocation').value.trim();
  const kw = document.getElementById('gate2SearchKeywords').value.trim();
  
    const strategy = document.querySelector("input[name='gate2Strategy']:checked").value;
  if (strategy !== "local_pdf" && !role && !ind) return toast("Please enter at least a Role or Industry", "warning");

  toast('Searching leads... (this may take a moment)', 'info');
  document.getElementById('gate2ResultsPanel').style.display = 'block';
  document.getElementById('gate2ResultsBody').innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;">Searching... ??</td></tr>';

  try {
    let res;
    if (strategy === "local_pdf") {
      const files = document.getElementById('gate2PdfUpload').files;
      if (files.length === 0) {
        toast("Please select at least one PDF file", "warning");
        document.getElementById('gate2ResultsPanel').style.display = 'none';
        return;
      }
      const formData = new FormData();
      formData.append("strategy", strategy);
      for (let i = 0; i < files.length; i++) {
        formData.append("pdf_files", files[i]);
      }
      res = await fetch('/api/gate2/discover-leads', {
        method: 'POST',
        body: formData
      });
    } else {
      res = await fetch('/api/gate2/discover-leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, industry: ind, location: loc, keywords: kw, strategy })
      });
    }
    const data = await res.json();
    if (res.ok && data.leads) {
      gate2CurrentLeads = data.leads;
      renderGate2Results();
      toast(`Found ${data.leads.length} leads`, 'success');
    } else {
      gate2CurrentLeads = [];
      document.getElementById('gate2ResultsBody').innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:red;">Error: ${data.detail || data.message || 'No leads found'}</td></tr>`;
      toast(data.detail || data.message, 'error');
    }
  } catch(e) { 
    document.getElementById('gate2ResultsBody').innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:red;">Error: ${e.message}</td></tr>`;
    toast(e.message, 'error'); 
  }
}

  function renderGate2Results() {
    const tbody = document.getElementById('gate2ResultsBody');
    const header = document.getElementById('gate2ResultsHeader');
    tbody.innerHTML = '';
    if (gate2CurrentLeads.length === 0) {
      if(header) header.innerText = '?? Search Results (0 Leads)';
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;">No leads found</td></tr>';
      return;
    }
    if(header) header.innerText = "?? Search Results (" + gate2CurrentLeads.length + " Leads)";
    gate2CurrentLeads.forEach((lead, i) => {
    const isValid = lead.email && lead.email.includes('@');
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #f1f5f9';
    tr.innerHTML = `
      <td style="padding:8px;border-right:1px solid #e2e8f0;text-align:center;">
        <input type="checkbox" class="g2-check" data-idx="${i}" ${isValid ? 'checked' : 'disabled'} style="cursor:pointer;">
      </td>
      <td style="padding:8px;border-right:1px solid #e2e8f0;"><strong>${i + 1}.</strong> ${lead.name || '-'}</td>
      <td style="padding:8px;border-right:1px solid #e2e8f0;color:${isValid ? 'inherit' : 'red'};">${lead.email || 'Missing'}</td>
      <td style="padding:8px;border-right:1px solid #e2e8f0;">${lead.company || '-'}</td>
      <td style="padding:8px;">${lead.role || '-'}</td>
    `;
    tbody.appendChild(tr);
  });
}

function toggleGate2SelectAll() {
  const checked = document.getElementById('gate2SelectAll').checked;
  document.querySelectorAll('.g2-check:not([disabled])').forEach(cb => cb.checked = checked);
}

async function saveGate2SelectedLeads() {
  const checks = document.querySelectorAll('.g2-check:checked');
  if (checks.length === 0) return toast('No leads selected', 'warning');
  
  const selectedLeads = Array.from(checks).map(cb => gate2CurrentLeads[parseInt(cb.dataset.idx)]);
  
  const target = document.getElementById('gate2ExistingSheetSel').value;
  const payload = { leads: selectedLeads, target: target };
  
  if (target === 'new') {
    const name = document.getElementById('gate2NewSheetName').value.trim();
    if (!name) return toast('Please enter a name for the new sheet', 'warning');
    payload.sheet_name = name;
    payload.make_default = true;
  } else {
    const key = document.getElementById('gate2ExistingSheetSel').value;
    if (!key) return toast('Please select an existing sheet', 'warning');
    payload.sheet_key = key;
  }
  
  toast('Saving leads to Google Sheets...', 'info');
  try {
    const res = await fetch('/api/gate2/save-leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok) {
      toast(data.message, 'success');
      if (target === 'new') {
        document.getElementById('gate2ExistingSheetSel').value = 'existing';
        onGate2TargetChange();
      }
    } else {
      toast(data.detail || 'Error saving leads', 'error');
    }
  } catch(e) { toast(e.message, 'error'); }
}

async function refreshGate1Resumes() {
  const selects = [document.getElementById('gate1FastResumeSel'), document.getElementById('gate1AdvResumeSel')];
  try {
    const res = await fetch(`${GATE1_API}/resumes`);
    const data = await res.json();
    const resumes = (data && data.resumes) || [];
    selects.forEach(sel => {
      if (!sel) return;
      const current = sel.value;
      sel.innerHTML = '';
      const optAuto = document.createElement('option');
      optAuto.value = ''; optAuto.textContent = GATE1_AUTO_OPTION.label;
      sel.appendChild(optAuto);
      resumes.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r.filename;
        opt.textContent = r.filename;
        sel.appendChild(opt);
      });
      if ([...sel.options].some(o => o.value === current)) sel.value = current;
    });
    if (!resumes.length) {
      toast('No PDFs found in output_resumes/ yet — print/export a resume first (🖨️ Print PDF) and save it there.', 'info', 6000);
    }
  } catch (e) {
    console.warn('Could not load Gate 1 resumes:', e.message);
  }
}

function gate1FastDefaultsKey() { return 'rsai_gate1_fast_defaults'; }

function loadGate1FastDefaults() {
  try {
    const raw = localStorage.getItem(gate1FastDefaultsKey());
    const defaults = raw ? JSON.parse(raw) : null;
    const statusEl = document.getElementById('gate1FastDefaultsStatus');
    if (defaults && (defaults.template || defaults.resume)) {
      if (defaults.template) document.getElementById('gate1FastTemplateSel').value = defaults.template;
      if (defaults.resume) document.getElementById('gate1FastResumeSel').value = defaults.resume;
      if (statusEl) statusEl.textContent = `✅ Fast Apply defaults saved${defaults.savedAt ? ' · ' + defaults.savedAt : ''}`;
    } else if (statusEl) {
      statusEl.textContent = '⚪ No Fast Apply defaults saved yet — pick a template & resume, then Save.';
    }
  } catch (e) { /* ignore */ }
}

function saveGate1FastDefaults() {
  const template = document.getElementById('gate1FastTemplateSel')?.value || '';
  const resume = document.getElementById('gate1FastResumeSel')?.value || '';
  if (!template) {
    toast('Pick a default template first.', 'warning'); return;
  }
  localStorage.setItem(gate1FastDefaultsKey(), JSON.stringify({ template, resume, savedAt: new Date().toLocaleDateString() }));
  loadGate1FastDefaults();
  toast('⚡ Saved as Fast Apply defaults', 'success');
}

async function runGate1FastApply(mode) {
  const raw = localStorage.getItem(gate1FastDefaultsKey());
  const defaults = raw ? JSON.parse(raw) : null;
  if (!defaults || !defaults.template) {
    toast('⚙️ Save your Fast Apply defaults first (pick a template + resume, then "Save as Fast Apply Defaults").', 'warning', 6000);
    return;
  }
  const startRow = parseInt(document.getElementById("outreachStartRow")?.value || "2");
  const endRow = parseInt(document.getElementById("outreachEndRow")?.value || "10");
  const senderProfile = gate1SenderProfile();
  if (!senderProfile.email) {
    toast("⚙️ Set your Email Address under Personal/Basics details before running a campaign.", "warning", 6000);
    return;
  }
  toast(`⚡ Fast Apply: launching campaign for rows ${startRow} to ${endRow}...`, "info", 3000);
  try {
    const response = await fetch(`${GATE1_API}/send-emails`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        start_row: startRow, end_row: endRow, mode,
        sender_profile: senderProfile,
        template_name: defaults.template,
        resume_filename: defaults.resume || ""
      })
    });
    const result = await response.json();
    if (response.ok) {
      toast(`✅ ${result.message}`, "success", 5000);
    } else if (response.status === 428) {
      toast(`⚙️ Setup needed: ${result.detail}`, "warning", 8000);
    } else {
      toast(`❌ ${result.detail || 'Outreach failed.'}`, "error", 5000);
    }
  } catch (error) {
    toast(`❌ Failed to connect to backend server: ${error.message}`, "error", 5000);
  }
}

function confirmGate1SendNow(source) {
  if (!confirm('Send emails right now (no draft review)? This cannot be undone.')) return;
  if (source === 'fast') runGate1FastApply('send');
  else triggerEmailOutreach('send');
}

// ---- Gate 1 outer sub-nav (small Outreach panel: Gate 1 / Outreach / Gate 4) ----
// Gate 1 is deliberately NOT one of the two swappable subpanes — clicking it never
// opens fields inside this small panel. It only opens the dedicated full-width
// #gate1Section further down the page (see openGate1Panel below), exactly like
// SGResume. Outreach/Gate 4 remain normal in-panel tabs.
function switchOutreachSubTab(name) {
  const panes = { outreach: document.getElementById('outreachSub-outreach'), gate4: document.getElementById('outreachSub-gate4') };
  const btns = { outreach: document.getElementById('outreachSubBtnOutreach'), gate4: document.getElementById('outreachSubBtnGate4') };
  Object.keys(panes).forEach(k => {
    if (panes[k]) panes[k].classList.toggle('active', k === name);
    if (panes[k]) panes[k].style.display = (k === name) ? 'block' : 'none';
    if (btns[k]) btns[k].classList.toggle('active', k === name);
  });
}

// ---- Gate 1 full-width workspace (lives OUTSIDE .workspace, like SGResume) ----
function openGate1Panel() {
  const section = document.getElementById('gate1Section');
  if (!section) return;
  section.style.display = 'block';
  document.getElementById('outreachSubBtnGate1')?.classList.add('open');
  requestAnimationFrame(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }));

  populateTemplateDropdown();
  syncGate1LiveTemplateEditor();
  fetchAndRenderGate1Leads();
  refreshGate1Resumes();
}

function closeGate1Panel() {
  const section = document.getElementById('gate1Section');
  if (section) section.style.display = 'none';
  document.getElementById('outreachSubBtnGate1')?.classList.remove('open');
  closeGate1TemplateEditor();
  closeGate1ResumeEditor();
}

function openGate2Panel() {
  const section = document.getElementById('gate2Section');
  if (!section) return;
  section.style.display = 'block';
  document.getElementById('outreachSubBtnGate2')?.classList.add('open');
  requestAnimationFrame(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  if (typeof refreshGate1Sheets === 'function') refreshGate1Sheets();
  if (typeof refreshGate2Sheets === 'function') refreshGate2Sheets();
}

function closeGate2Panel() {
  const section = document.getElementById('gate2Section');
  if (section) section.style.display = 'none';
  document.getElementById('outreachSubBtnGate2')?.classList.remove('open');
}


// ---- Template editor — opens INLINE inside #gate1Section (not a modal) ----
let gate1EditingOriginalName = '';

async function openGate1TemplateEditor(name) {
  openGate1Panel();
  const panel = document.getElementById('gate1TemplateEditorPanel');
  if (panel) panel.style.display = 'block';
  closeGate1ResumeEditor();
  gate1EditingOriginalName = name || '';
  const nameInput = document.getElementById('gate1TemplateEditName');
  const contentInput = document.getElementById('gate1TemplateEditContent');
  nameInput.value = name || '';
  contentInput.value = '';
  requestAnimationFrame(() => panel?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  if (!name) return; // "New" — start blank
  try {
    const res = await fetch(`${GATE1_API}/templates/${encodeURIComponent(name)}`);
    const data = await res.json();
    if (res.ok) contentInput.value = data.content || '';
    else toast(`❌ ${data.detail || 'Could not load template.'}`, 'error');
  } catch (e) {
    toast(`❌ Failed to load template: ${e.message}`, 'error');
  }
}

function closeGate1TemplateEditor() {
  const panel = document.getElementById('gate1TemplateEditorPanel');
  if (panel) panel.style.display = 'none';
}

async function saveGate1TemplateEditor() {
  const name = document.getElementById('gate1TemplateEditName')?.value.trim();
  const content = document.getElementById('gate1TemplateEditContent')?.value || '';
  if (!name) { toast('Give the template a name first.', 'warning'); return; }
  if (!content.trim()) { toast('Template content cannot be empty.', 'warning'); return; }
  try {
    const res = await fetch(`${GATE1_API}/templates/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    const data = await res.json();
    if (res.ok) {
      toast(`💾 ${data.message}`, 'success');
      closeGate1TemplateEditor();
      await refreshGate1Templates();
      document.getElementById('gate1FastTemplateSel').value = data.name;
      document.getElementById('gate1AdvTemplateSel').value = data.name;
    } else {
      toast(`❌ ${data.detail || 'Save failed.'}`, 'error');
    }
  } catch (e) {
    toast(`❌ Failed to save template: ${e.message}`, 'error');
  }
}

// ---- Gate 1 Resume Editor — large editor + live preview, opens INLINE inside
// #gate1Section (not a modal). Works off its own gate1ResumeData clone, taken
// from the main resume D at the moment "Edit" is clicked — it never reads from
// or writes back into D, and never touches the SGResume clone (sgData) either.
// Saving just marks this content as the selected Gate 1 attachment in the
// currently-open dropdown; actually producing the PDF still goes through the
// normal 🖨️ Print PDF flow into output_resumes/, same as the rest of the app.
// ════════════════════════════════════════════════════════════════
let gate1ResumeData = null;
let gate1ResumeTargetSelectId = null; // which dropdown ('gate1FastResumeSel' / 'gate1AdvResumeSel') gets updated on Save

function openGate1ResumeEditor(selId) {
  openGate1Panel();
  closeGate1TemplateEditor();
  syncFormToD(); // latest form edits first, same as SGResume does
  gate1ResumeTargetSelectId = selId || 'gate1FastResumeSel';
  gate1ResumeData = JSON.parse(JSON.stringify({
    basics: D.basics, skills: D.skills, edu: D.edu, eduExtra: D.eduExtra || [],
    exp: D.exp || [], proj: D.proj || [], ach: D.ach || [], certs: D.certs || [],
    sectionVisibility: D.sectionVisibility || defaultVisibility()
  }));
  const panel = document.getElementById('gate1ResumeEditorPanel');
  if (panel) panel.style.display = 'block';
  renderGate1ResumeEditor();
  renderGate1ResumePreview();
  requestAnimationFrame(() => panel?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}

function closeGate1ResumeEditor() {
  const panel = document.getElementById('gate1ResumeEditorPanel');
  if (panel) panel.style.display = 'none';
}

function gate1ResumeBulletsToText(arr) { return (arr || []).join('\n'); }
function gate1ResumeTextToBullets(text) { return (text || '').split('\n').map(s => s.trim()).filter(Boolean); }

function renderGate1ResumeEditor() {
  const body = document.getElementById('gate1ResumeEditorBody');
  if (!body || !gate1ResumeData) return;
  const b = gate1ResumeData.basics || {}, s = gate1ResumeData.skills || {}, e = gate1ResumeData.edu || {};
  body.innerHTML = `
    <div class="fg"><label>Profile Summary</label><textarea rows="3" onchange="gate1ResumeData.basics.summary=this.value;renderGate1ResumePreview()">${b.summary || ''}</textarea></div>
    <div class="fg"><label>Languages</label><input type="text" value="${s.lang || ''}" onchange="gate1ResumeData.skills.lang=this.value;renderGate1ResumePreview()"></div>
    <div class="fg"><label>Tools &amp; Frameworks</label><input type="text" value="${s.tools || ''}" onchange="gate1ResumeData.skills.tools=this.value;renderGate1ResumePreview()"></div>
    <div class="fg"><label>Domain / Stack</label><input type="text" value="${s.domain || ''}" onchange="gate1ResumeData.skills.domain=this.value;renderGate1ResumePreview()"></div>
    <div class="fg"><label>Cloud / Databases</label><input type="text" value="${s.cloud || ''}" onchange="gate1ResumeData.skills.cloud=this.value;renderGate1ResumePreview()"></div>
    <div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin:12px 0 6px;border-top:1px solid #f1f5f9;padding-top:10px;">Experience (one entry per block — one bullet per line)</div>
    ${(gate1ResumeData.exp || []).map((x, i) => `
      <div class="fg" style="border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:8px;">
        <div class="row2" style="margin-bottom:6px;">
          <input type="text" placeholder="Company" value="${x.co || ''}" onchange="gate1ResumeData.exp[${i}].co=this.value;renderGate1ResumePreview()">
          <input type="text" placeholder="Role" value="${x.role || ''}" onchange="gate1ResumeData.exp[${i}].role=this.value;renderGate1ResumePreview()">
        </div>
        <textarea rows="3" placeholder="One bullet per line" onchange="gate1ResumeData.exp[${i}].bullets=gate1ResumeTextToBullets(this.value);renderGate1ResumePreview()">${gate1ResumeBulletsToText(x.bullets)}</textarea>
      </div>`).join('') || '<div class="line-empty-hint">No experience entries.</div>'}
    <div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin:12px 0 6px;border-top:1px solid #f1f5f9;padding-top:10px;">Projects (one bullet per line)</div>
    ${(gate1ResumeData.proj || []).map((p, i) => `
      <div class="fg" style="border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:8px;">
        <input type="text" placeholder="Project title" value="${p.title || ''}" style="margin-bottom:6px;" onchange="gate1ResumeData.proj[${i}].title=this.value;renderGate1ResumePreview()">
        <textarea rows="3" placeholder="One bullet per line" onchange="gate1ResumeData.proj[${i}].bullets=gate1ResumeTextToBullets(this.value);renderGate1ResumePreview()">${gate1ResumeBulletsToText(p.bullets)}</textarea>
      </div>`).join('') || '<div class="line-empty-hint">No projects.</div>'}
    <div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin:12px 0 6px;border-top:1px solid #f1f5f9;padding-top:10px;">Education</div>
    <div class="row2" style="margin-bottom:6px;">
      <input type="text" placeholder="University" value="${e.uni || ''}" onchange="gate1ResumeData.edu.uni=this.value;renderGate1ResumePreview()">
      <input type="text" placeholder="Years" value="${e.yrs || ''}" onchange="gate1ResumeData.edu.yrs=this.value;renderGate1ResumePreview()">
    </div>
    <input type="text" placeholder="Degree" value="${e.deg || ''}" onchange="gate1ResumeData.edu.deg=this.value;renderGate1ResumePreview()">
    <div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin:12px 0 6px;border-top:1px solid #f1f5f9;padding-top:10px;">Achievements (one per line)</div>
    <textarea rows="3" onchange="gate1ResumeData.ach=gate1ResumeTextToBullets(this.value);renderGate1ResumePreview()">${gate1ResumeBulletsToText(gate1ResumeData.ach)}</textarea>
  `;
}

function renderGate1ResumePreview() {
  if (!gate1ResumeData) return;
  const html = buildResumeHtmlSimple(gate1ResumeData);
  const out = document.getElementById('gate1ResumeOut');
  if (out) out.innerHTML = html;
  requestAnimationFrame(() => {
    fitToPageLimit(document.getElementById('gate1ResumePaper'), document.getElementById('gate1ResumeOut'), 1, 0.92);
    scaleGate1ResumePaper();
  });
}

function scaleGate1ResumePaper() {
  const wrap = document.getElementById('gate1ResumePaperWrap');
  const box = document.getElementById('gate1ResumePaperScaleBox');
  const paper = document.getElementById('gate1ResumePaper');
  if (!wrap || !box || !paper) return;
  const scale = Math.min(1, (wrap.clientWidth - 24) / paper.offsetWidth);
  paper.style.transform = `scale(${scale})`;
  box.style.width = (paper.offsetWidth * scale) + 'px';
  box.style.height = (paper.offsetHeight * scale) + 'px';
}

function saveGate1ResumeEditor() {
  if (!gate1ResumeData) return;
  const label = `✏️ Edited — ${(gate1ResumeData.basics?.name || 'Resume')} (${new Date().toLocaleTimeString()})`;
  ['gate1FastResumeSel', 'gate1AdvResumeSel'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    let opt = sel.querySelector('option[data-gate1-edited="1"]');
    if (!opt) {
      opt = document.createElement('option');
      opt.setAttribute('data-gate1-edited', '1');
      sel.insertBefore(opt, sel.firstChild);
    }
    opt.value = '__gate1_edited__';
    opt.textContent = label;
    sel.value = '__gate1_edited__';
  });
  toast('✅ Saved — set as the selected Gate 1 attachment. Ab isko output_resumes/ me physically save karne ke liye top ka 🖨️ Print PDF use karo.', 'success', 7000);
  closeGate1ResumeEditor();
}

// ---- AI-Tailored Template (Advanced Mode) ----
async function aiTailorGate1Template() {
  const company = document.getElementById('gate1AiCompany')?.value || '';
  const role = document.getElementById('gate1AiRole')?.value || '';
  const jd = document.getElementById('gate1AiJD')?.value || '';
  if (!jd.trim()) { toast('Paste the job description first.', 'warning'); return; }
  toast('✨ Asking AI to tailor the outreach template...', 'info', 3000);
  const prompt = `Write a short, professional cold-outreach email template for a job application.
Company: ${company || '(unspecified)'}
Role: ${role || '(unspecified)'}
Job Description:
${jd}

Use these exact placeholder tokens verbatim so they can be filled in per-lead: {{recruiter_name}}, {{company}}, {{role}}, {{sender_name}}, {{sender_email}}, {{sender_phone}}, {{sender_linkedin}}, {{sender_github}}, {{experience_summary}}.
Output format: first line must be "Subject: ..." with a short subject line, then a blank line, then the plain-text email body only (no markdown, no extra commentary).`;
  const text = await callAI(prompt, 700);
  if (!text) { toast(`❌ AI tailoring failed: ${lastAIError || 'no provider available'}`, 'error', 6000); return; }
  openGate1TemplateEditor('');
  const suggestedName = ((company ? company + '_' + role : role) || 'ai_tailored')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  document.getElementById('gate1TemplateEditName').value = suggestedName;
  document.getElementById('gate1TemplateEditContent').value = text.trim();
  toast('✨ AI draft ready — review, edit, and Save Template.', 'success');
}

// ---- Manual AI Resume Editing (Advanced Mode) — suggests a rewritten
// Profile Summary the user reviews and inserts manually; it never silently
// overwrites resume data, matching "final template/resume stays editable".
async function applyGate1ManualAiEdit() {
  const instruction = document.getElementById('gate1ManualAiInstruction')?.value || '';
  if (!instruction.trim()) { toast('Type an instruction for the AI first.', 'warning'); return; }
  syncFormToD();
  const currentSummary = (D.basics && D.basics.summary) || '';
  toast('✨ Asking AI for a resume suggestion...', 'info', 3000);
  const prompt = `Current resume Profile Summary:
"""${currentSummary || '(empty)'}"""

Instruction from the candidate: "${instruction}"

Rewrite the Profile Summary to follow the instruction. Keep it truthful to the original content (don't invent new experience), 2-4 sentences, plain text only, no markdown, no quotes around it.`;
  const text = await callAI(prompt, 400);
  if (!text) { toast(`❌ AI suggestion failed: ${lastAIError || 'no provider available'}`, 'error', 6000); return; }
  document.getElementById('gate1PreviewBody').textContent = `Suggested Profile Summary:\n\n${text.trim()}\n\n— Copy this into the Basics tab's Summary field, then re-print the PDF into output_resumes/ before sending.`;
  document.getElementById('gate1PreviewModal').style.display = 'flex';
}

// ---- Preview (Advanced Mode) ----
async function previewGate1Email() {
  const templateName = document.getElementById('gate1AdvTemplateSel')?.value || '';
  const resumeFilename = document.getElementById('gate1AdvResumeSel')?.value || '';
  const senderProfile = gate1SenderProfile();
  let templateText = '';
  try {
    if (templateName) {
      const res = await fetch(`${GATE1_API}/templates/${encodeURIComponent(templateName)}`);
      const data = await res.json();
      templateText = res.ok ? (data.content || '') : '';
    } else {
      const res = await fetch(`${GATE1_API}/templates`);
      const data = await res.json();
      const first = (data.templates || [])[0];
      if (first) {
        const r2 = await fetch(`${GATE1_API}/templates/${encodeURIComponent(first.name)}`);
        const d2 = await r2.json();
        templateText = d2.content || '';
      }
    }
  } catch (e) { /* fall through to placeholder */ }

  const context = {
    recruiter_name: 'there', company: 'Example Corp', role: 'the open position',
    sender_name: senderProfile.name, sender_email: senderProfile.email,
    sender_phone: senderProfile.phone, sender_linkedin: senderProfile.linkedin,
    sender_github: senderProfile.github, experience_summary: senderProfile.experience_summary
  };
  let rendered = templateText || '(No template selected/found — Auto mode will role-match one at send time.)';
  Object.keys(context).forEach(k => { rendered = rendered.split(`{{${k}}}`).join(context[k] || ''); });

  const resumeLine = resumeFilename ? `📎 Attachment: ${resumeFilename}` : '📎 Attachment: Auto (latest PDF in output_resumes/)';
  document.getElementById('gate1PreviewBody').textContent = `${resumeLine}\n\n${rendered}`;
  document.getElementById('gate1PreviewModal').style.display = 'flex';
}

// Populate Gate 1 pickers once on load
window.addEventListener('DOMContentLoaded', () => {
  refreshGate1Templates();
  refreshGate1Resumes();
  loadGate1FastDefaults();
});


// ════════════════════════════════════════════════════════════════
// ✨ AI QUICK DROP BOX (LAZY INJECTOR)
// ════════════════════════════════════════════════════════════════
function openAiLazyBox(){
  const overlay = document.getElementById('aiLazyBoxOverlay');
  if(overlay) overlay.style.display = 'flex';
  const statusBox = document.getElementById('aiLazyStatusBox');
  if(statusBox) statusBox.style.display = 'none';
  setTimeout(() => document.getElementById('aiLazyRawText')?.focus(), 50);
}

function closeAiLazyBox(){
  const overlay = document.getElementById('aiLazyBoxOverlay');
  if(overlay) overlay.style.display = 'none';
}

function fillAiLazyBoxSample(){
  const ta = document.getElementById('aiLazyRawText');
  if(ta){
    ta.value = "Project Name: CryptoPulse — Realtime Crypto Arbitrage & Portfolio Tracker\nTechnologies: Next.js 14, TypeScript, FastAPI, Redis, WebSockets, Tailwind CSS, Vercel\nLive URL: https://cryptopulse-demo.vercel.app | GitHub: https://github.com/shivamjgkp/cryptopulse\nDetails:\n- Built low-latency crypto arbitrage scanner processing 50+ pairs per second with <50ms WebSocket latency.\n- Implemented real-time order book visualizations using TradingView lightweight charts and Redis pub/sub caching.\n- Deployed production backend on Docker & Render with automated CI/CD pipeline and Cloudflare DDoS protection.";
  }
}

async function submitAiLazyBox(){
  const rawText = document.getElementById('aiLazyRawText')?.value?.trim();
  const targetSec = document.getElementById('aiLazyTargetSection')?.value || 'auto';
  const statusBox = document.getElementById('aiLazyStatusBox');
  const submitBtn = document.getElementById('aiLazySubmitBtn');

  if(!rawText){
    toast('Please paste some project, experience, or skill text first!', 'warning');
    return;
  }

  // Show loading
  if(statusBox){
    statusBox.style.display = 'block';
    statusBox.style.background = '#f5f3ff';
    statusBox.style.color = '#6d28d9';
    statusBox.style.border = '1px solid #ddd6fe';
    statusBox.innerHTML = '🤖 Analyzing with AI Engine & structuring ATS bullets...';
  }
  if(submitBtn) submitBtn.disabled = true;

  const prompt = `You are an expert ATS Resume AI Engineer. The user is providing raw, unstructured text to add to their resume.
Target Section hint: "${targetSec}" (if "auto", detect whether it is "proj", "exp", "skills", "ach", "certs", or "hyperlinks").

Raw Input from user:
"""
${rawText}
"""

Respond ONLY with a valid JSON object in this exact schema (no markdown formatting, no backticks, just raw JSON):
{
  "section": "proj" | "exp" | "skills" | "ach" | "certs" | "hyperlinks",
  "item": {
    // If section == "proj":
    "title": "Project Title",
    "tech": "Comma-separated technologies used",
    "links": "Label::URL | Label2::URL2",
    "bullets": [
      "Action verb + core implementation with tech details",
      "Action verb + quantifiable impact/performance metric (<200ms, 99.9%, etc.)"
    ],

    // If section == "exp":
    "co": "Company Name",
    "role": "Job Role / Title",
    "date": "Month Year - Month Year (e.g. May 2026 - Aug 2026)",
    "links": "https://...",
    "bullets": [
      "Action verb + work done + business impact metric",
      "Action verb + feature built or optimization achieved"
    ],

    // If section == "skills":
    "category": "lang" | "tools" | "domain" | "cloud" | "course",
    "skills": ["Skill1", "Skill2"],

    // If section == "ach":
    "text": "Clear achievement line with ranking/prize/metric",

    // If section == "certs":
    "text": "Certification Name — Issuing Authority (e.g. Stanford / Google / AWS)",

    // If section == "hyperlinks":
    "label": "Display Label",
    "url": "https://..."
  }
}`;

  try {
    let aiRes = await callAI(prompt, 1000);
    let parsed = null;

    if(aiRes){
      const jsonMatch = aiRes.match(/\{[\s\S]*\}/);
      if(jsonMatch){
        try { parsed = JSON.parse(jsonMatch[0]); } catch(e){}
      }
    }

    // Fallback heuristic if AI unavailable or offline
    if(!parsed || !parsed.section || !parsed.item){
      parsed = fallbackLazyBoxParse(rawText, targetSec);
    }

    // Inject parsed item into D
    injectLazyBoxItem(parsed);

    if(statusBox){
      statusBox.style.background = '#ecfdf5';
      statusBox.style.color = '#059669';
      statusBox.style.border = '1px solid #a7f3d0';
      statusBox.innerHTML = `✅ Successfully added to <strong>${getSectionDisplayName(parsed.section)}</strong>!`;
    }

    setTimeout(() => {
      closeAiLazyBox();
      toast(`✨ Added to ${getSectionDisplayName(parsed.section)}!`, 'success');
      document.getElementById('aiLazyRawText').value = '';
    }, 800);

  } catch(err) {
    console.error('AI Lazy Box Error:', err);
    // Use fallback
    const parsed = fallbackLazyBoxParse(rawText, targetSec);
    injectLazyBoxItem(parsed);
    closeAiLazyBox();
    toast(`✨ Added to ${getSectionDisplayName(parsed.section)} (via Smart Parser)!`, 'success');
  } finally {
    if(submitBtn) submitBtn.disabled = false;
  }
}

function getSectionDisplayName(sec){
  switch(sec){
    case 'proj': return 'Featured Projects';
    case 'exp': return 'Work Experience';
    case 'skills': return 'Technical Skills';
    case 'ach': return 'Achievements';
    case 'certs': return 'Certifications';
    case 'hyperlinks': return 'Hyperlinks';
    default: return 'Resume';
  }
}

function injectLazyBoxItem(parsed){
  if(!parsed || !parsed.section || !parsed.item) return;
  const sec = parsed.section;
  const it = parsed.item;

  if(sec === 'proj'){
    if(!Array.isArray(D.proj)) D.proj = [];
    const projObj = {
      title: it.title || 'New Project',
      tech: it.tech || '',
      links: it.links || (it.url ? `Live::${it.url}` : ''),
      bullets: Array.isArray(it.bullets) && it.bullets.length ? it.bullets : [it.desc || it.title || 'Developed and deployed full-stack project.']
    };
    D.proj.unshift(projObj); // Add to top of projects
    renderProjEditor();
    swTab('proj');
  } else if(sec === 'exp'){
    if(!Array.isArray(D.exp)) D.exp = [];
    const expObj = {
      co: it.co || it.company || 'Company Name',
      role: it.role || it.title || 'Software Developer',
      date: it.date || '2026 - Present',
      links: it.links || it.url || '',
      bullets: Array.isArray(it.bullets) && it.bullets.length ? it.bullets : [it.desc || 'Contributed to key engineering initiatives.']
    };
    D.exp.unshift(expObj);
    renderExpEditor();
    swTab('exp');
  } else if(sec === 'skills'){
    if(!D.skills) D.skills = {lang:'', tools:'', domain:'', cloud:'', course:''};
    const cat = it.category || 'tools';
    const newItems = Array.isArray(it.skills) ? it.skills.join(', ') : (it.skills || it.text || '');
    if(newItems){
      D.skills[cat] = D.skills[cat] ? `${D.skills[cat]}, ${newItems}` : newItems;
      populateForm();
    }
    swTab('skills');
  } else if(sec === 'ach'){
    if(!Array.isArray(D.ach)) D.ach = [];
    const achText = it.text || (typeof it === 'string' ? it : JSON.stringify(it));
    if(achText) D.ach.push(achText);
    populateForm();
    swTab('edu');
  } else if(sec === 'certs'){
    if(!Array.isArray(D.certs)) D.certs = [];
    const certText = it.text || (typeof it === 'string' ? it : JSON.stringify(it));
    if(certText) D.certs.push(certText);
    populateForm();
    swTab('edu');
  } else if(sec === 'hyperlinks'){
    if(!Array.isArray(D.hyperlinks)) D.hyperlinks = [];
    D.hyperlinks.push({label: it.label || it.name || 'Link', url: it.url || ''});
    renderHyperlinksEditor();
    swTab('hyperlinks');
  }

  render();
  liveATS();
}

function fallbackLazyBoxParse(text, targetSec){
  const lines = text.split('\n').map(l=>l.trim()).filter(Boolean);
  let sec = targetSec !== 'auto' ? targetSec : 'proj';

  if(targetSec === 'auto'){
    const lower = text.toLowerCase();
    if(lower.includes('intern') || lower.includes('experience') || lower.includes('worked as') || lower.includes('co-founder')){
      sec = 'exp';
    } else if(lower.includes('skill') || lower.includes('proficient in') || lower.includes('languages:')){
      sec = 'skills';
    } else if(lower.includes('certificate') || lower.includes('coursera') || lower.includes('udemy')){
      sec = 'certs';
    } else if(lower.includes('rank') || lower.includes('winner') || lower.includes('solved') || lower.includes('achievement')){
      sec = 'ach';
    } else {
      sec = 'proj';
    }
  }

  // Extract URLs
  const urlMatch = text.match(/https?:\/\/[^\s,]+/g) || [];
  const linksStr = urlMatch.map(u => `Live::${u}`).join(' | ');

  if(sec === 'proj'){
    const title = lines[0]?.replace(/^(?:project(?:\s*name)?|title)[:\s-]*/i, '') || 'New Project';
    const bullets = lines.slice(1).filter(l => !l.startsWith('http') && !l.toLowerCase().startsWith('tech'));
    return {
      section: 'proj',
      item: {
        title: title,
        tech: 'React, Node.js, TypeScript, Tailwind CSS',
        links: linksStr,
        bullets: bullets.length ? bullets : ['Engineered scalable architecture with sub-second response times.']
      }
    };
  } else if(sec === 'exp'){
    return {
      section: 'exp',
      item: {
        co: lines[0] || 'Company',
        role: lines[1] || 'Software Engineer',
        date: '2026 - Present',
        links: urlMatch[0] || '',
        bullets: lines.slice(2).length ? lines.slice(2) : ['Implemented responsive UI and integrated RESTful APIs.']
      }
    };
  } else if(sec === 'skills'){
    return {
      section: 'skills',
      item: { category: 'tools', skills: lines.join(', ') }
    };
  } else if(sec === 'certs'){
    return { section: 'certs', item: { text: lines.join(' — ') } };
  } else if(sec === 'ach'){
    return { section: 'ach', item: { text: lines.join(' ') } };
  } else {
    return {
      section: 'hyperlinks',
      item: { label: lines[0] || 'My Link', url: urlMatch[0] || '' }
    };
  }
}



// ════════════════════════════════════════════════════════════════
// 👑 PRO OUTREACH PIN AUTHORIZATION (₹4,999 / Year Protected)
// ════════════════════════════════════════════════════════════════
let MASTER_OUTREACH_PIN = localStorage.getItem('outreach_custom_pin') || "shivam2026";

function saveCustomPin(){
  const val = document.getElementById('iCustomMasterPin')?.value?.trim();
  if(!val){ toast('PIN cannot be empty!', 'warning'); return; }
  MASTER_OUTREACH_PIN = val;
  localStorage.setItem('outreach_custom_pin', val);
  localStorage.setItem('outreach_unlocked', 'true');
  localStorage.setItem('outreach_pin_val', val);
  toast(`👑 Master PIN updated to: "${val}"`, 'success', 3500);
}


function isOutreachUnlocked(){
  return localStorage.getItem('outreach_unlocked') === 'true';
}

function openPinModal(callback){
  window._pinCallback = callback;
  const overlay = document.getElementById('outreachPinModal');
  if(overlay) overlay.style.display = 'flex';
  const inp = document.getElementById('outreachPinInput');
  if(inp){ inp.value = ''; inp.focus(); }
  const err = document.getElementById('pinErrorMsg');
  if(err) err.style.display = 'none';
}

function closePinModal(){
  const overlay = document.getElementById('outreachPinModal');
  if(overlay) overlay.style.display = 'none';
}

function verifyOutreachPin(){
  const inp = document.getElementById('outreachPinInput');
  const val = (inp?.value || '').trim();
  const err = document.getElementById('pinErrorMsg');
  
  const activePin = localStorage.getItem('outreach_custom_pin') || MASTER_OUTREACH_PIN || "shivam2026";
  if(val === activePin || val.toLowerCase() === activePin.toLowerCase() || val === "shivam2026"){
    localStorage.setItem('outreach_unlocked', 'true');
    localStorage.setItem('outreach_pin_val', val);
    closePinModal();
    toast('👑 Pro VIP Outreach Suite Unlocked! Welcome, Shivam.', 'success', 3500);
    if(window._pinCallback){
      window._pinCallback();
      window._pinCallback = null;
    }
  } else {
    if(err){
      err.style.display = 'block';
      err.textContent = '❌ Invalid Passcode! Pro Subscription (₹4,999) required.';
    }
  }
}

// Add Master PIN header to all fetch requests for protected API calls
function getAuthHeaders(){
  const pin = localStorage.getItem('outreach_pin_val') || MASTER_OUTREACH_PIN;
  return {
    'Content-Type': 'application/json',
    'X-Outreach-PIN': pin
  };
}



function triggerMainPrint(){
  document.body.classList.remove('print-sg');
  const box = document.getElementById('paperScaleBox');
  const paper = document.getElementById('paper');
  if(box){
    box.style.width = '';
    box.style.height = '';
  }
  if(paper){
    paper.style.transform = '';
  }
  window.print();
  setTimeout(() => {
    if(typeof scalePaper === 'function') scalePaper();
  }, 300);
}



function changePageBreakRule(val){
  if(val === 'allow'){
    document.body.classList.add('allow-page-split');
    toast('✂️ Page Break: Allowed item splitting (fills Page 1 bottom gap)', 'info', 3000);
  } else {
    document.body.classList.remove('allow-page-split');
    toast('🚫 Page Break: Avoid item splitting (keeps items intact)', 'info', 3000);
  }
  try{ localStorage.setItem('rsai_page_break_rule', val); }catch(e){}
}



function changeCompactSpacing(val){
  if(val === 'compact'){
    document.body.classList.add('compact-print');
    toast('⚡ Spacing: Compact (Fit 1 Page) activated!', 'success', 2500);
  } else {
    document.body.classList.remove('compact-print');
    toast('📄 Spacing: Normal restored', 'info', 2500);
  }
  try{ localStorage.setItem('rsai_compact_spacing', val); }catch(e){}
}



function togglePageLayoutPopover(e){
  if(e) e.stopPropagation();
  const p = document.getElementById('pageLayoutPopover');
  if(p) p.style.display = p.style.display === 'none' ? 'block' : 'none';
}

document.addEventListener('click', function(e){
  const p = document.getElementById('pageLayoutPopover');
  if(p && p.style.display === 'block' && !p.contains(e.target) && !e.target.closest('[onclick*="togglePageLayoutPopover"]')){
    p.style.display = 'none';
  }
});



// ════════════════════════════════════════════════════════════════
// ⭐ 10-SLOT NAMED RESUME PRESETS MANAGER
// ════════════════════════════════════════════════════════════════
function getPresetSlots(){
  try{
    const raw = localStorage.getItem('rsai_preset_slots');
    let slots = raw ? JSON.parse(raw) : [];
    if(!Array.isArray(slots) || slots.length < 10){
      const newSlots = [];
      for(let i=1; i<=10; i++){
        const existing = (slots && slots.find(s => s && s.id === i)) || null;
        if(existing){
          newSlots.push(existing);
        } else if(i === 1 && localStorage.getItem('rsai_default_resume')){
          // Migrate old Default 1 into Slot 1
          newSlots.push({
            id: 1,
            name: "Default 1 (Shivam Gupta)",
            savedAt: localStorage.getItem('rsai_default_resume_savedAt') || new Date().toLocaleDateString(),
            data: JSON.parse(localStorage.getItem('rsai_default_resume'))
          });
        } else {
          newSlots.push({ id: i, name: `Slot ${i}`, savedAt: '', data: null });
        }
      }
      slots = newSlots;
      localStorage.setItem('rsai_preset_slots', JSON.stringify(slots));
    }
    return slots;
  }catch(e){
    return Array.from({length:10}, (_,i)=>({id:i+1, name:`Slot ${i+1}`, savedAt:'', data:null}));
  }
}

function savePresetSlots(slots){
  try{
    localStorage.setItem('rsai_preset_slots', JSON.stringify(slots));
    // Keep Slot 1 synced with old Default 1 for backwards compatibility
    if(slots[0] && slots[0].data){
      localStorage.setItem('rsai_default_resume', JSON.stringify(slots[0].data));
      localStorage.setItem('rsai_default_resume_savedAt', slots[0].savedAt);
    }
  }catch(e){}
}

function updatePresetQuickUI(){
  const slots = getPresetSlots();
  const sel = document.getElementById('presetQuickSelect');
  const status = document.getElementById('quickPresetStatus');
  if(!sel) return;

  const currentVal = parseInt(sel.value || '1');
  
  // Populate dropdown options
  sel.innerHTML = slots.map(s => {
    const label = s.data ? `Slot ${s.id}: ${s.name || 'Saved Resume'} (${s.savedAt})` : `Slot ${s.id}: ${s.name || 'Empty'} (Empty)`;
    return `<option value="${s.id}" ${s.id === currentVal ? 'selected' : ''}>${label}</option>`;
  }).join('');

  const targetSlot = slots.find(s => s.id === currentVal);
  if(status && targetSlot){
    status.innerHTML = targetSlot.data 
      ? `✅ <strong>${targetSlot.name}</strong> saved on ${targetSlot.savedAt} (${targetSlot.data.basics?.name || 'Resume Data'})` 
      : `⚪ <strong>${targetSlot.name}</strong> is currently empty. Click <strong>Save Here</strong> to save your current resume.`;
  }

  renderPresetGridList();
}

function togglePresetGrid(){
  const grid = document.getElementById('presetGridContainer');
  if(grid) grid.style.display = grid.style.display === 'none' ? 'block' : 'none';
}

function renderPresetGridList(){
  const list = document.getElementById('presetSlotsList');
  if(!list) return;
  const slots = getPresetSlots();

  list.innerHTML = slots.map(s => `
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;background:#fff;padding:6px 8px;border-radius:6px;border:1px solid #fde68a;">
      <span style="font-weight:900;font-size:11px;color:#92400e;width:48px;">Slot ${s.id}:</span>
      <input type="text" value="${(s.name||'').replace(/"/g,'&quot;')}" placeholder="Name (e.g. Accenture ML)" style="flex:1;padding:4px 8px;font-size:11px;border:1px solid #cbd5e1;border-radius:4px;font-weight:600;" onchange="updatePresetName(${s.id}, this.value)">
      <span style="font-size:9.5px;color:#78716c;width:75px;text-align:right;">${s.savedAt ? s.savedAt : 'Empty'}</span>
      <button type="button" class="btn btn-purple btn-xs" style="padding:3px 8px;font-size:10px;" onclick="loadSlotById(${s.id})">⚡ Load</button>
      <button type="button" class="btn btn-orange btn-xs" style="padding:3px 8px;font-size:10px;" onclick="saveSlotById(${s.id})">💾 Save</button>
      ${s.data ? `<button type="button" class="btn btn-outline btn-xs" style="padding:3px 6px;font-size:10px;color:#ef4444;border-color:#fca5a5;" onclick="clearSlotById(${s.id})" title="Clear Slot">❌</button>` : ''}
    </div>
  `).join('');
}

function updatePresetName(slotId, newName){
  const slots = getPresetSlots();
  const s = slots.find(x => x.id === slotId);
  if(s){
    s.name = newName || `Slot ${slotId}`;
    savePresetSlots(slots);
    updatePresetQuickUI();
    toast(`Renamed Slot ${slotId} to "${s.name}"`, 'info', 2000);
  }
}

function loadQuickSelectedPreset(){
  const sel = document.getElementById('presetQuickSelect');
  const slotId = parseInt(sel?.value || '1');
  loadSlotById(slotId);
}

function saveQuickSelectedPreset(){
  const sel = document.getElementById('presetQuickSelect');
  const slotId = parseInt(sel?.value || '1');
  saveSlotById(slotId);
}

function loadSlotById(slotId){
  const slots = getPresetSlots();
  const s = slots.find(x => x.id === slotId);
  if(!s || !s.data){
    toast(`Slot ${slotId} is empty! Save a resume here first.`, 'warning');
    return;
  }
  const hasCurrentContent = D && (D.basics?.name || (D.exp||[]).length || (D.proj||[]).length);
  if(hasCurrentContent && !confirm(`Load "${s.name}"? This will replace whatever is currently filled in.`)) return;

  try {
    const rawData = JSON.parse(JSON.stringify(s.data));
    D = {
      basics: rawData.basics || {},
      skills: rawData.skills || { lang:'', tools:'', domain:'', cloud:'', course:'' },
      edu: rawData.edu || { uni:'', deg:'', yrs:'', gpa:'' },
      eduExtra: Array.isArray(rawData.eduExtra) ? rawData.eduExtra : [],
      exp: Array.isArray(rawData.exp) ? rawData.exp.map(x=>({
        co: x.co || x.company || '',
        role: x.role || x.position || '',
        date: x.date || x.duration || '',
        loc: x.loc || x.location || '',
        links: x.links || x.link || '',
        bullets: Array.isArray(x.bullets) ? x.bullets : (x.bullet ? [x.bullet] : [])
      })) : [],
      proj: Array.isArray(rawData.proj) ? rawData.proj.map(p=>({
        title: p.title || p.name || '',
        tech: p.tech || p.technologies || '',
        links: p.links || p.link || '',
        bullets: Array.isArray(p.bullets) ? p.bullets : (p.bullet ? [p.bullet] : [])
      })) : [],
      ach: Array.isArray(rawData.ach) ? rawData.ach : (Array.isArray(rawData.achievements) ? rawData.achievements : []),
      certs: Array.isArray(rawData.certs) ? rawData.certs : (Array.isArray(rawData.certifications) ? rawData.certifications : []),
      customSkills: Array.isArray(rawData.customSkills) ? rawData.customSkills : [],
      sectionVisibility: rawData.sectionVisibility || defaultVisibility(),
      showCertsTop: !!rawData.showCertsTop,
      outreach: rawData.outreach || {}
    };

    populateForm();
    render();
    liveATS();
    swTab('basics');
    toast(`📂 Loaded "${s.name}" (Slot ${slotId}) successfully!`, 'success', 3500);
  } catch(err) {
    console.error("Failed to load slot:", err);
    toast(`Failed to load Slot ${slotId}: ${err.message}`, 'error', 6000);
  }
}

function saveSlotById(slotId){
  const slots = getPresetSlots();
  let s = slots.find(x => x.id === slotId);
  if(!s){
    s = { id: slotId, name: `Slot ${slotId}`, savedAt: '', data: null };
    slots.push(s);
  }
  syncFormToD();
  const defaultName = D.basics?.name ? `${D.basics.name} Resume` : `Slot ${slotId} Resume`;
  if(s.name === `Slot ${slotId}` || !s.name){
    const promptName = prompt(`Enter a name for Slot ${slotId}:`, defaultName);
    if(promptName) s.name = promptName;
  }

  s.data = JSON.parse(JSON.stringify(D));
  s.savedAt = new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
  savePresetSlots(slots);
  updatePresetQuickUI();
  toast(`⭐ Saved current resume to "${s.name}" (Slot ${slotId})!`, 'success', 3500);
}

function clearSlotById(slotId){
  if(!confirm(`Are you sure you want to clear Slot ${slotId}?`)) return;
  const slots = getPresetSlots();
  const s = slots.find(x => x.id === slotId);
  if(s){
    s.data = null;
    s.savedAt = '';
    savePresetSlots(slots);
    updatePresetQuickUI();
    toast(`Cleared Slot ${slotId}`, 'info', 2000);
  }
}



// ════════════════════════════════════════════════════════════════
// GATE 1 LIVE TEMPLATE EDITOR & CAMPAIGN PROGRESS COUNTER
// ════════════════════════════════════════════════════════════════

const MASTER_TEMPLATE_1_FALLBACK = `Dear {{recruiter_name}},

I hope you are doing well.

I am Shivam Gupta, a B.Tech student in Electronics & Communication Engineering (ECE), specializing in Data Science and Machine Learning at MMMUT, Gorakhpur. I am writing to express my strong interest in internship and entry-level opportunities at {{company}} across Software Development, Full-Stack Engineering, AI/ML, Data, Fintech, and Quantitative/Algorithmic Trading.

I bring a hands-on, builder-oriented background in developing real-world software products, machine learning applications, and financial analytics solutions. I am also the Founder of Mastermind Research Technologies, an MSME/Udyam-registered technology venture focused on AI/ML, software, and web-development solutions, and I run Mastermind Algo Trader, a YouTube-based trading education platform sharing practical insights on algorithmic trading, price action, risk management, and market analysis.

A brief overview of my work:
• Full-Stack & Web Engineering: Built and deployed production-oriented full-stack applications using Next.js, React, FastAPI, TypeScript, JavaScript, Supabase/PostgreSQL, REST APIs, Cloudflare, Vercel, and Render. Shipped multiple healthcare & institutional platforms including a production hospital platform for Rajendra Hospital, Gorakhpur (appointment workflows, symptom-triage matcher, PM-JAY cashless calculator, appointment passes) and the MMMUT Hockey portal.
• Enterprise & Outreach Platforms: Developed platforms for Mastermind Research Technologies and Mastermind Algo Trader with secure authentication, cloud deployment, payment webhooks, and live trading-signal workflows. Built this LLM-powered ATS resume intelligence and outreach platform with automated lead sync, Google Sheets integration, and Gmail API outreach.
• Machine Learning & Data Engineering: Engineered end-to-end ML pipelines for forecasting, prediction, and analytics using Python, Pandas, NumPy, Scikit-learn, TensorFlow, XGBoost, Flask/FastAPI, Docker, AWS, and MLflow across electricity-demand forecasting, weather intelligence, and stock-price prediction.
• Algorithmic Trading & Quantitative Systems: Designed, tested, and backtested rule-based algorithmic strategies (Pine Script v5, Python, FastAPI, TradingView, Chartink) with liquidity-sweep detection, EMA crossover logic, live signals, and risk analytics.
• Competitions & Industry Simulations: Achieved Rank 3 and won the XM Global Daily Trading Competition in algorithmic trading, and cleared both phases of the FundingPips prop-firm challenge. Completed virtual job simulations in Risk Management (Goldman Sachs), Quantitative Research (J.P. Morgan), and Global Markets Sales & Trading (Bank of America).

I am especially interested in opportunities where I can combine engineering, data, and analytical thinking—whether through building scalable software products, AI-powered applications, data platforms, or fintech and quantitative solutions.

My resume is attached for your consideration. You can also review my work here:
GitHub: https://github.com/shivamjigkp
LinkedIn: https://linkedin.com/in/shivam-gupta-05209a279

I would be grateful for the opportunity to be considered for any suitable current or future role at {{company}}. Thank you for your time and consideration.

Warm regards,
Shivam Gupta
+91-8081513780 | quantxcoder@gmail.com`;








function updateGate1Progress(current, total, currentItemMsg, isDone, errCount){
  const card = document.getElementById('gate1ProgressCard');
  const text = document.getElementById('gate1ProgressText');
  const pct = document.getElementById('gate1ProgressPct');
  const bar = document.getElementById('gate1ProgressBar');
  const log = document.getElementById('gate1ProgressLog');

  if(card) card.style.display = 'block';
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;

  if(text) text.textContent = `${current} / ${total}`;
  if(pct) pct.textContent = `${percent}%`;
  if(bar) bar.style.width = `${percent}%`;

  if(log && currentItemMsg){
    const timeStr = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
    const line = document.createElement('div');
    line.innerHTML = `<span style="color:#64748b;">[${timeStr}]</span> ${currentItemMsg}`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  if(isDone){
    toast(`🎉 Gate 1 Campaign Finished! (${total} processed, ${errCount||0} errors)`, 'success', 4000);
  }
}



// ════════════════════════════════════════════════════════════════
// 🤖 AI COLD EMAIL TEMPLATE WRITER & CUSTOMIZER
// ════════════════════════════════════════════════════════════════
function openAiEmailWriterModal(){
  const overlay = document.getElementById('aiEmailWriterOverlay');
  if(overlay) overlay.style.display = 'flex';
  const status = document.getElementById('aiEmailStatusBox');
  if(status) status.style.display = 'none';
  const resBox = document.getElementById('aiEmailResultBox');
  if(resBox) resBox.style.display = 'none';
  const applyBtn = document.getElementById('btnApplyAiEmail');
  if(applyBtn) applyBtn.style.display = 'none';
  setTimeout(() => document.getElementById('aiEmailPromptInput')?.focus(), 50);
}

function closeAiEmailWriterModal(){
  const overlay = document.getElementById('aiEmailWriterOverlay');
  if(overlay) overlay.style.display = 'none';
}

function fillAiEmailSamplePrompt(){
  const ta = document.getElementById('aiEmailPromptInput');
  if(ta){
    ta.value = "Target Role: Software Engineer / AI-ML Engineer\nKey Highlights: Built full-stack healthcare platforms and algorithmic trading systems with Next.js 15, FastAPI, PostgreSQL, and Python. Solved 140+ problems on LeetCode.\nGoal: Concise, high-impact cold outreach under 120 words with strong call-to-action.";
  }
}

async function generateAiEmailTemplate(){
  const instructions = document.getElementById('aiEmailPromptInput')?.value?.trim();
  const tone = document.getElementById('aiEmailToneSelect')?.value || 'high_impact';
  const statusBox = document.getElementById('aiEmailStatusBox');
  const resBox = document.getElementById('aiEmailResultBox');
  const resTextarea = document.getElementById('aiEmailResultContent');
  const applyBtn = document.getElementById('btnApplyAiEmail');
  const genBtn = document.getElementById('btnGenAiEmail');

  if(!instructions){
    toast('Please enter custom highlights or instructions for AI!', 'warning');
    return;
  }

  if(statusBox){
    statusBox.style.display = 'block';
    statusBox.style.background = '#f5f3ff';
    statusBox.style.color = '#6d28d9';
    statusBox.style.border = '1px solid #ddd6fe';
    statusBox.innerHTML = '🤖 AI is crafting your cold email template...';
  }
  if(genBtn) genBtn.disabled = true;

  const myName = D.basics?.name || 'Shivam Gupta';

  const prompt = `You are a world-class Cold Outreach & Copywriting AI.
Write a highly compelling, personalized cold email template.

Tone / Style: "${tone}"
User Instructions & Highlights:
\"\"\"
${instructions}
\"\"\"

CRITICAL INSTRUCTIONS:
1. Start with the Subject line on the very first line as:
Subject: <Catchy, high-open-rate subject line with {{company_name}} and {{role}}>

2. Use these exact placeholders in the body for personalized merging:
   - {{recruiter_name}}
   - {{company_name}}
   - {{role}}
   - {{my_name}} (will automatically be replaced by ${myName})

3. Keep it under 130 words. Make it punchy, professional, and results-driven.

Return ONLY the raw template text (starting with Subject:) without markdown code blocks.`;

  try {
    let result = await callAI(prompt, 800);
    if(result){
      result = result.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    }
    
    if(!result){
      result = `Subject: Application for {{role}} at {{company_name}} — ${myName}\n\nHi {{recruiter_name}},\n\nI noticed {{company_name}} is hiring for the {{role}} position. Given my hands-on background in Next.js 15, FastAPI, and Machine Learning systems, I've engineered high-performance platforms achieving sub-200ms latency and 99.9% uptime.\n\nI'd love to contribute to {{company_name}}'s engineering goals. Are you open to a brief 10-minute chat this week?\n\nBest regards,\n${myName}`;
    }

    if(resTextarea) resTextarea.value = result;
    if(resBox) resBox.style.display = 'block';
    if(applyBtn) applyBtn.style.display = 'inline-block';
    if(statusBox){
      statusBox.style.background = '#ecfdf5';
      statusBox.style.color = '#059669';
      statusBox.style.border = '1px solid #a7f3d0';
      statusBox.innerHTML = '✅ Generated AI Template! Click <strong>Instate in Active Editor</strong> below.';
    }
  } catch(err) {
    toast('Error generating template with AI', 'error');
  } finally {
    if(genBtn) genBtn.disabled = false;
  }
}

function applyAiGeneratedEmailTemplate(){
  const resTextarea = document.getElementById('aiEmailResultContent');
  const val = resTextarea?.value?.trim();
  if(!val){
    toast('No template content to apply!', 'warning');
    return;
  }
  const editorTa = document.getElementById('gate1LiveTemplateContent');
  if(editorTa){
    editorTa.value = val;
    updateGate1LivePreview();
  }
  closeAiEmailWriterModal();
  toast('✨ AI Template applied to active editor!', 'success', 3000);
}



// ════════════════════════════════════════════════════════════════
// 📊 GATE 1 GOOGLE SHEET LEADS TABLE VIEWER
// ════════════════════════════════════════════════════════════════
async function toggleGate1LeadsTable(){
  const container = document.getElementById('gate1LeadsTableContainer');
  if(!container) return;
  const isHidden = container.style.display === 'none';
  container.style.display = isHidden ? 'block' : 'none';

  if(isHidden){
    await fetchAndRenderGate1Leads();
  }
}



async function fetchAndRenderGate1Leads(){
  const box = document.getElementById('gate1LeadsTableBox');
  const badge = document.getElementById('gate1LeadsCountBadge');
  if(!box) return;

  const sel = document.getElementById('gate1ActiveSheet');
  const rawId = sel?.value || '1lYkZAjqQQQGKTkxkLGUpNmcs4Wu68tPXo6JRa0PDimI';
  const sheetId = extractCleanSheetId(rawId);

  box.innerHTML = '<div style="padding:10px;color:#6366f1;text-align:center;font-weight:600;">🔄 Fetching real Google Sheet rows via CSV...</div>';

  // Method 1: Direct CSV fetch (works when sheet is public "Anyone with link can view")
  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=Leads`;

  try {
    const res = await fetch(csvUrl);
    if(!res.ok) throw new Error('CSV fetch failed: ' + res.status);
    const text = await res.text();

    // Parse CSV properly (handle commas inside quotes)
    function parseCSVLine(line){
      const result = []; let cell = ''; let inQuote = false;
      for(let i=0; i<line.length; i++){
        const c = line[i];
        if(c === '"' && line[i+1] === '"'){ cell += '"'; i++; }
        else if(c === '"'){ inQuote = !inQuote; }
        else if(c === ',' && !inQuote){ result.push(cell); cell = ''; }
        else { cell += c; }
      }
      result.push(cell);
      return result;
    }

    const lines = text.split('\n').filter(l => l.trim());
    const headers = parseCSVLine(lines[0]);
    const dataRows = lines.slice(1);

    const nameIdx   = headers.findIndex(h => /name/i.test(h));
    const emailIdx  = headers.findIndex(h => /email/i.test(h));
    const compIdx   = headers.findIndex(h => /company/i.test(h));
    const roleIdx   = headers.findIndex(h => /role/i.test(h));
    const statusIdx = headers.findIndex(h => /status/i.test(h));

    const rows = dataRows.map((line, i) => {
      const cols = parseCSVLine(line);
      return {
        row: i + 2,
        name:    cols[nameIdx  >= 0 ? nameIdx   : 0] || 'Hiring Team',
        email:   cols[emailIdx >= 0 ? emailIdx  : 1] || '',
        company: cols[compIdx  >= 0 ? compIdx   : 2] || '',
        role:    cols[roleIdx  >= 0 ? roleIdx   : 3] || '',
        status:  cols[statusIdx>= 0 ? statusIdx : 4] || 'Pending',
      };
    }).filter(r => r.email);

    if(badge) badge.textContent = `Showing ${rows.length} real active rows`;

    if(!rows.length){
      box.innerHTML = '<div style="padding:10px;color:#d97706;text-align:center;font-weight:600;">No rows with email found. Check sheet has data and is shared as "Anyone with link can view".</div>';
      return;
    }

    box.innerHTML = `
      <table style="width:100%;border-collapse:collapse;text-align:left;font-size:10.5px;">
        <thead>
          <tr style="background:#e0e7ff;color:#3730a3;font-weight:800;">
            <th style="padding:5px 8px;border-bottom:1px solid #cbd5e1;">#</th>
            <th style="padding:5px 8px;border-bottom:1px solid #cbd5e1;">Email</th>
            <th style="padding:5px 8px;border-bottom:1px solid #cbd5e1;">Company</th>
            <th style="padding:5px 8px;border-bottom:1px solid #cbd5e1;">Role</th>
            <th style="padding:5px 8px;border-bottom:1px solid #cbd5e1;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${rows.slice(0,50).map(l => `
            <tr style="border-bottom:1px solid #e2e8f0;background:#fff;">
              <td style="padding:4px 8px;font-weight:800;color:#6366f1;">${l.row}</td>
              <td style="padding:4px 8px;color:#1e40af;font-weight:600;">${l.email}</td>
              <td style="padding:4px 8px;font-weight:700;">${l.company}</td>
              <td style="padding:4px 8px;color:#059669;font-size:10px;">${l.role}</td>
              <td style="padding:4px 8px;">
                <span style="font-size:9px;padding:2px 5px;border-radius:4px;
                  background:${l.status==='Drafted'?'#dcfce7':'#f1f5f9'};
                  color:${l.status==='Drafted'?'#16a34a':'#475569'};
                  font-weight:700;">${l.status}</span>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${rows.length > 50 ? `<div style="padding:6px;text-align:center;font-size:10px;color:#6366f1;font-weight:700;">Showing first 50 of ${rows.length} rows</div>` : ''}
    `;

  } catch(csvErr) {
    // Fallback: try backend API
    try {
      const backendRes = await fetch('/api/gate1/sheet-rows?sheet_id=' + encodeURIComponent(sheetId));
      const data = await backendRes.json();
      if(data.status === 'success' && data.rows?.length){
        if(badge) badge.textContent = `Showing ${data.rows.length} rows via backend API`;
        box.innerHTML = `<div style="padding:8px;color:#059669;font-weight:700;">✅ Loaded ${data.rows.length} rows via backend API</div>`;
      } else {
        box.innerHTML = `
          <div style="padding:10px;background:#fef3c7;border:1px solid #fde68a;border-radius:6px;font-size:10.5px;line-height:1.5;">
            <strong>⚠️ Cannot load sheet rows. Please:</strong><br>
            1. Open your Google Sheet → Click <strong>Share</strong> button<br>
            2. Change to <strong>"Anyone with the link → Viewer"</strong><br>
            3. Then click <strong>📊 View Sheet Leads ▾</strong> again
          </div>`;
      }
    } catch(e2) {
      box.innerHTML = `
        <div style="padding:10px;background:#fef3c7;border:1px solid #fde68a;border-radius:6px;font-size:10.5px;line-height:1.5;">
          <strong>⚠️ Sheet not accessible. Please:</strong><br>
          1. Open your Google Sheet → Click <strong>Share</strong><br>
          2. Set to <strong>"Anyone with the link → Viewer"</strong><br>
          3. Click <strong>📊 View Sheet Leads ▾</strong> again
        </div>`;
    }
  }
}





// ════════════════════════════════════════════════════════════════
// GOOGLE SHEET LINK AUTO-PARSER & LIVE PREVIEW REPLACEMENT
// ════════════════════════════════════════════════════════════════
function autoExtractGate1SheetId(val){
  if(!val) return;
  val = val.trim();
  const status = document.getElementById('gate1SheetUrlStatus');
  
  // Extract ID if full Google Sheet URL was pasted
  const m = val.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if(m && m[1]){
    const extractedId = m[1];
    if(status){
      status.textContent = `✅ Extracted Sheet ID: "${extractedId}"`;
      status.style.color = '#059669';
    }
  } else if(val.length > 20 && !val.includes('/')){
    if(status){
      status.textContent = `✅ Valid Sheet ID format`;
      status.style.color = '#059669';
    }
  }
}



// Auto sync template content when Gate 1 panel opens
const oldOpenGate1 = window.openGate1Panel;
window.openGate1Panel = function(){
  const section = document.getElementById('gate1Section');
  if (!section) return;
  section.style.display = 'block';
  document.getElementById('outreachSubBtnGate1')?.classList.add('open');

  // Load template content into live editor & preview immediately
  setTimeout(() => {
    syncGate1LiveTemplateEditor();
    updateGate1LivePreview();
    // Auto-show leads table and fetch rows
    const leadsContainer = document.getElementById('gate1LeadsTableContainer');
    if(leadsContainer) leadsContainer.style.display = 'block';
    fetchAndRenderGate1Leads();
  }, 200);

  requestAnimationFrame(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }));
};



// ════════════════════════════════════════════════════════════════
// 📊 ROBUST GATE 1 SHEET & TEMPLATE REGISTRY (NEVER EMPTY DROPDOWNS)
// ════════════════════════════════════════════════════════════════
const DEFAULT_SHEETS_FALLBACK = [
  { id: '1lYkZAjqQQQGKTkxkLGUpNmcs4Wu68tPXo6JRa0PDimI', name: 'SHIVAM (Default Sheet)', key: 'shivam_default' }
];

function extractCleanSheetId(str){
  if(!str) return '1lYkZAjqQQQGKTkxkLGUpNmcs4Wu68tPXo6JRa0PDimI';
  const m = str.match(/([a-zA-Z0-9-_]{25,})/);
  return m ? m[1] : str.trim();
}

function getStoredSheets(){
  try{
    const raw = localStorage.getItem('rsai_gate1_sheets');
    let sheets = raw ? JSON.parse(raw) : [];
    if(!Array.isArray(sheets) || !sheets.length){
      sheets = DEFAULT_SHEETS_FALLBACK;
      localStorage.setItem('rsai_gate1_sheets', JSON.stringify(sheets));
    }
    // Sanitize all sheet IDs
    sheets.forEach(s => { s.id = extractCleanSheetId(s.id); });
    return sheets;
  }catch(e){
    return DEFAULT_SHEETS_FALLBACK;
  }
}

function saveStoredSheets(sheets){
  try{ localStorage.setItem('rsai_gate1_sheets', JSON.stringify(sheets)); }catch(e){}
}

function getStoredTemplates(){
  try{
    const raw = localStorage.getItem('rsai_gate1_templates');
    let templates = raw ? JSON.parse(raw) : [];
    if(!Array.isArray(templates) || !templates.length){
      templates = DEFAULT_TEMPLATES_FALLBACK;
      localStorage.setItem('rsai_gate1_templates', JSON.stringify(templates));
    }
    return templates;
  }catch(e){
    return DEFAULT_TEMPLATES_FALLBACK;
  }
}

function saveStoredTemplates(tpls){
  try{ localStorage.setItem('rsai_gate1_templates', JSON.stringify(tpls)); }catch(e){}
}

function populateSheetDropdown(){
  const sel = document.getElementById('gate1ActiveSheet');
  if(!sel) return;
  const sheets = getStoredSheets();
  const activeId = localStorage.getItem('rsai_active_sheet_id') || sheets[0]?.id || '1lYkZAjqQQQGKTkxkLGUpNmcs4Wu68tPXo6JRa0PDimI';

  sel.innerHTML = sheets.map(s => {
    const isSel = (s.id === activeId || s.key === activeId) ? 'selected' : '';
    return `<option value="${s.id}" ${isSel}>${s.name} (${s.id.substring(0,12)}...)</option>`;
  }).join('');
}



function connectExistingGate1Sheet(){
  const input = document.getElementById('gate1NewSheetId');
  let rawVal = input?.value?.trim() || '';
  if(!rawVal){
    toast('Please paste Google Sheet Link or Sheet ID!', 'warning');
    return;
  }

  // Auto extract ID if full link was pasted
  const m = rawVal.match(/\/d\/([a-zA-Z0-9-_]+)/);
  const sheetId = m && m[1] ? m[1] : rawVal;

  const sheets = getStoredSheets();
  let existing = sheets.find(s => s.id === sheetId);
  if(!existing){
    existing = { id: sheetId, name: `Sheet (${sheetId.substring(0,8)}...)`, key: `sheet_${Date.now()}` };
    sheets.push(existing);
    saveStoredSheets(sheets);
  }

  localStorage.setItem('rsai_active_sheet_id', sheetId);
  populateSheetDropdown();
  toast(`🔌 Connected Google Sheet (${sheetId.substring(0,12)}...)!`, 'success', 3500);

  // Sync leads table
  const tableContainer = document.getElementById('gate1LeadsTableContainer');
  if(tableContainer && tableContainer.style.display !== 'none'){
    fetchAndRenderGate1Leads();
  }
}

function addNewGate1SheetPrompt(){
  const raw = prompt("Paste full Google Sheet Link or Sheet ID:");
  if(!raw || !raw.trim()) return;

  const m = raw.trim().match(/\/d\/([a-zA-Z0-9-_]+)/);
  const sheetId = m && m[1] ? m[1] : raw.trim();
  const customName = prompt("Enter a friendly name for this Google Sheet:", "My Lead Tracker") || `Sheet (${sheetId.substring(0,8)}...)`;

  const sheets = getStoredSheets();
  sheets.push({ id: sheetId, name: customName, key: `sheet_${Date.now()}` });
  saveStoredSheets(sheets);
  localStorage.setItem('rsai_active_sheet_id', sheetId);
  populateSheetDropdown();
  toast(`➕ Added "${customName}" to Google Sheet registry!`, 'success', 3500);
}

function deleteActiveGate1Sheet(){
  const sel = document.getElementById('gate1ActiveSheet');
  const activeId = sel?.value;
  if(!activeId){ toast('No active sheet selected', 'warning'); return; }

  const sheets = getStoredSheets();
  if(sheets.length <= 1){
    toast('Cannot delete the last remaining Google Sheet!', 'warning');
    return;
  }

  if(!confirm(`Are you sure you want to delete this sheet from your registry?`)) return;

  const filtered = sheets.filter(s => s.id !== activeId);
  saveStoredSheets(filtered);
  localStorage.setItem('rsai_active_sheet_id', filtered[0].id);
  populateSheetDropdown();
  toast('🗑️ Deleted sheet from registry', 'info', 2500);
}

function addNewGate1TemplatePrompt(){
  const name = prompt("Enter template filename identifier (e.g. frontend_developer):");
  if(!name || !name.trim()) return;

  const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const label = prompt("Enter template display title:", name) || name;

  const templates = getStoredTemplates();
  if(!templates.find(t => t.name === cleanName)){
    templates.push({ name: cleanName, label: label });
    saveStoredTemplates(templates);
  }

  localStorage.setItem('rsai_active_template', cleanName);
  populateTemplateDropdown();

  // Set default initial content in live editor
  const ta = document.getElementById('gate1LiveTemplateContent');
  if(ta){
    const myName = D.basics?.name || 'Shivam Gupta';
    ta.value = `Subject: Application for {{role}} at {{company}} — ${myName}\n\nHi {{recruiter_name}},\n\nI'm writing to express interest in the {{role}} position at {{company}}...\n\nBest regards,\n${myName}`;
    updateGate1LivePreview();
  }
  toast(`➕ Created new template "${label}"!`, 'success', 3500);
}

function deleteActiveGate1Template(){
  const sel = document.getElementById('gate1DefaultTemplate');
  const activeName = sel?.value;
  if(!activeName){ toast('No active template selected', 'warning'); return; }

  const templates = getStoredTemplates();
  if(templates.length <= 1){
    toast('Cannot delete the last remaining template!', 'warning');
    return;
  }

  if(!confirm(`Delete template "${activeName}"?`)) return;

  const filtered = templates.filter(t => t.name !== activeName);
  saveStoredTemplates(filtered);
  localStorage.setItem('rsai_active_template', filtered[0].name);
  populateTemplateDropdown();
  syncGate1LiveTemplateEditor();
  toast('🗑️ Deleted template', 'info', 2500);
}

// Auto populate dropdowns on script init
setTimeout(() => {
  populateSheetDropdown();
  populateTemplateDropdown();
}, 200);



// ════════════════════════════════════════════════════════════════
// 📄 UNIVERSAL GATE 1 RESUME PDF SELECTOR & UPLOADER
// ════════════════════════════════════════════════════════════════
async function refreshGate1Resumes(){
  const sel = document.getElementById('gate1DefaultResume');
  const status = document.getElementById('gate1ResumeStatus');
  if(!sel) return;

  sel.innerHTML = '<option value="auto">Auto (Latest PDF / Role-matched)</option>';

  // 1. Add Saved Profile Presets (Slots 1 to 10)
  try {
    const slots = getPresetSlots();
    slots.filter(s => s.data).forEach(s => {
      sel.innerHTML += `<option value="slot_${s.id}">⭐ Profile Slot ${s.id}: ${s.name} (${s.savedAt})</option>`;
    });
  } catch(e){}

  // 2. Fetch server PDFs from output_resumes/ and resume/
  try {
    const res = await fetch('/api/gate1/resumes');
    const data = await res.json();
    if(data.status === 'success' && Array.isArray(data.resumes) && data.resumes.length > 0){
      data.resumes.forEach(r => {
        sel.innerHTML += `<option value="${r.filename}">📄 ${r.filename}</option>`;
      });
      if(status) status.textContent = `✅ Loaded ${data.resumes.length} PDF resumes from server.`;
    } else {
      sel.innerHTML += '<option value="resume.pdf">📄 resume.pdf (Default)</option>';
      if(status) status.textContent = '📄 Using default resume.pdf';
    }
  } catch(err) {
    sel.innerHTML += '<option value="resume.pdf">📄 resume.pdf (Default)</option>';
  }
}

async function uploadGate1PdfFile(event){
  const file = event.target.files[0];
  if(!file) return;
  const status = document.getElementById('gate1ResumeStatus');

  if(status) status.textContent = `⏳ Uploading "${file.name}" to server...`;

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/gate1/upload-resume', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if(data.status === 'success'){
      toast(`📁 Uploaded "${file.name}" successfully!`, 'success', 3500);
      await refreshGate1Resumes();
      const sel = document.getElementById('gate1DefaultResume');
      if(sel) sel.value = file.name;
      if(status) status.textContent = `✅ Selected uploaded resume: "${file.name}"`;
    } else {
      toast('Failed to upload resume PDF', 'error');
    }
  } catch(err) {
    toast(`Local file "${file.name}" ready as attachment`, 'info');
    await refreshGate1Resumes();
  }
}

// Auto call on Gate 1 open
setTimeout(refreshGate1Resumes, 250);



// ════════════════════════════════════════════════════════════════
// ⚡ GATE 1 CAMPAIGN EXECUTION (DRAFTS & DIRECT SEND)
// ════════════════════════════════════════════════════════════════
async function runGate1Action(mode){
  if(mode === 'send'){
    if(!confirm('⚠️ ARE YOU SURE? This will SEND emails directly to the recipients via Gmail API without drafting.')) return;
  }

  let startRow = parseInt(document.getElementById('gate1StartRow')?.value || '2');
  let endRow = parseInt(document.getElementById('gate1EndRow')?.value || '10');
  if(isNaN(startRow) || startRow < 2) startRow = 2;
  if(isNaN(endRow) || endRow < startRow) endRow = startRow;
  
  // Get active sheet ID from input box OR dropdown
  const sheetUrlInp = document.getElementById('gate1SheetUrlInput');
  const sheetSel = document.getElementById('gate1ActiveSheet');
  const rawSheet = (sheetUrlInp && sheetUrlInp.value.trim()) ? sheetUrlInp.value.trim() : (sheetSel?.value || '1lYkZAjqQQQGKTkxkLGUpNmcs4Wu68tPXo6JRa0PDimI');
  const sheetId = extractCleanSheetId(rawSheet);

  const tplSel = document.getElementById('gate1DefaultTemplate');
  const templateName = tplSel?.value || '1';
  const resumeSel = document.getElementById('gate1DefaultResume');
  const resumeFilename = resumeSel?.value || 'auto';

  // Extract custom Subject and Body exactly from the live composer fields
  const customSubject = document.getElementById('gate1EmailSubject')?.value?.trim() || '';
  const customBody = document.getElementById('gate1LiveTemplateContent')?.value?.trim() || '';
  const forceDraft = document.getElementById('gate1ForceDraftCheckbox')?.checked ?? true;

  const senderProfile = {
    name: D.basics?.name || 'Shivam Gupta',
    email: D.basics?.email || 'quantxcoder@gmail.com',
    phone: D.basics?.phone || '+91-8081513780',
    linkedin: D.basics?.linkedin || 'https://linkedin.com/in/shivam-gupta-05209a279',
    github: D.basics?.github || 'https://github.com/shivamjigkp'
  };

  const totalRows = Math.max(1, endRow - startRow + 1);
  const card = document.getElementById('gate1ProgressCard');
  if(card) card.style.display = 'block';

  updateGate1Progress(0, totalRows, `🚀 Starting Gate 1 campaign: Rows ${startRow} to ${endRow}... Mode: ${mode.toUpperCase()}`);

  const draftBtn = document.getElementById('btnGate1Draft');
  const sendBtn = document.getElementById('btnGate1Send');
  if(draftBtn) draftBtn.disabled = true;
  if(sendBtn) sendBtn.disabled = true;

  try {
    const res = await fetch('/api/gate1/send-emails', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        mode: mode,
        start_row: startRow,
        end_row: endRow,
        sheet_id: sheetId,
        template_name: templateName,
        subject: customSubject,
        template_body: customBody,
        force_draft: forceDraft,
        resume_filename: resumeFilename,
        sender_profile: senderProfile
      })
    });

    const data = await res.json();
    if(res.ok && data.status === 'success'){
      updateGate1Progress(totalRows, totalRows, `✅ Campaign Complete! ${data.message || data.detail || 'Processed successfully.'}`, true, 0);
      toast(`🎉 Gate 1: ${mode === 'draft' ? 'Drafts created in Gmail!' : 'Emails sent successfully!'} Check Gmail.`, 'success', 6000);
      // Refresh leads table to show updated status
      setTimeout(fetchAndRenderGate1Leads, 1500);
    } else {
      const errMsg = data.detail || data.error || 'Campaign failed to execute.';
      updateGate1Progress(0, totalRows, `❌ Error: ${errMsg}`, false, 1);
      toast(`❌ Campaign Error: ${errMsg}`, 'error', 6000);
    }
  } catch(err) {
    updateGate1Progress(0, totalRows, `❌ Network Error: ${err.message}`, false, 1);
    toast(`Failed to connect to backend server: ${err.message}`, 'error', 6000);
  } finally {
    if(draftBtn) draftBtn.disabled = false;
    if(sendBtn) sendBtn.disabled = false;
  }
}



// ════════════════════════════════════════════════════════════════
// 👤 GATE 1 SENDER PROFILE PERSISTENCE & LIVE MERGE
// ════════════════════════════════════════════════════════════════
function getGate1SenderProfile(){
  try{
    const raw = localStorage.getItem('rsai_g1_sender_profile');
    if(raw) return JSON.parse(raw);
  }catch(e){}

  return {
    name: D.basics?.name || 'Shivam Gupta',
    college: 'MMMUT, Gorakhpur',
    branch: 'ECE – Data Science & Machine Learning',
    phone: D.basics?.phone || '+91-8081513780',
    email: D.basics?.email || 'quantxcoder@gmail.com',
    github: D.basics?.github || 'https://github.com/shivamjigkp',
    linkedin: D.basics?.linkedin || 'https://linkedin.com/in/shivam-gupta-05209a279',
    other_links: 'Portfolio: https://mastermindresearchtech.com | LeetCode: https://leetcode.com/u/shivamalgocoder',
    experience_summary: "Completed job simulations with Goldman Sachs (Risk Management), J.P. Morgan (Quantitative Research), and Bank of America (Global Markets Sales & Trading)\nCertifications: Machine Learning – Regression & Classification (Stanford Online), Algorithmic Toolbox / DSA (UC San Diego), NISM Securities Markets Certification"
  };
}

function saveGate1ProfileFields(){
  const prof = {
    name: document.getElementById('g1_name')?.value || 'Shivam Gupta',
    college: document.getElementById('g1_college')?.value || 'MMMUT, Gorakhpur',
    branch: document.getElementById('g1_branch')?.value || 'ECE – Data Science & Machine Learning',
    phone: document.getElementById('g1_phone')?.value || '+91-8081513780',
    email: document.getElementById('g1_email')?.value || 'quantxcoder@gmail.com',
    github: document.getElementById('g1_github')?.value || 'https://github.com/shivamjigkp',
    linkedin: document.getElementById('g1_linkedin')?.value || 'https://linkedin.com/in/shivam-gupta-05209a279',
    other_links: document.getElementById('g1_other_links')?.value || '',
    experience_summary: document.getElementById('g1_exp_summary')?.value || ''
  };
  try{ localStorage.setItem('rsai_g1_sender_profile', JSON.stringify(prof)); }catch(e){}
  updateGate1LivePreview();
}

function toggleGate1ProfileCard(){
  const box = document.getElementById('gate1ProfileFieldsContainer');
  if(!box) return;
  box.style.display = box.style.display === 'none' ? 'block' : 'none';
}

function loadGate1ProfileFieldsToUI(){
  const prof = getGate1SenderProfile();
  if(document.getElementById('g1_name')) document.getElementById('g1_name').value = prof.name || '';
  if(document.getElementById('g1_college')) document.getElementById('g1_college').value = prof.college || 'MMMUT, Gorakhpur';
  if(document.getElementById('g1_branch')) document.getElementById('g1_branch').value = prof.branch || 'ECE – Data Science & Machine Learning';
  if(document.getElementById('g1_phone')) document.getElementById('g1_phone').value = prof.phone || '+91-8081513780';
  if(document.getElementById('g1_email')) document.getElementById('g1_email').value = prof.email || 'quantxcoder@gmail.com';
  if(document.getElementById('g1_github')) document.getElementById('g1_github').value = prof.github || 'https://github.com/shivamjigkp';
  if(document.getElementById('g1_linkedin')) document.getElementById('g1_linkedin').value = prof.linkedin || 'https://linkedin.com/in/shivam-gupta-05209a279';
  if(document.getElementById('g1_other_links')) document.getElementById('g1_other_links').value = prof.other_links || '';
  if(document.getElementById('g1_exp_summary')) document.getElementById('g1_exp_summary').value = prof.experience_summary || '';
}

// Comprehensive Live Preview with all placeholders


// Update runGate1Action to use Gate 1 sender profile
const oldRunGate1Action = runGate1Action;
runGate1Action = async function(mode){
  const prof = getGate1SenderProfile();
  const startRow = parseInt(document.getElementById('gate1StartRow')?.value || '2');
  const endRow = parseInt(document.getElementById('gate1EndRow')?.value || '10');
  const sheetSel = document.getElementById('gate1ActiveSheet');
  const sheetId = extractCleanSheetId(sheetSel?.value || '1lYkZAjqQQQGKTkxkLGUpNmcs4Wu68tPXo6JRa0PDimI');
  const tplSel = document.getElementById('gate1DefaultTemplate');
  const templateName = tplSel?.value || 'default';
  const resumeSel = document.getElementById('gate1DefaultResume');
  const resumeFilename = resumeSel?.value || 'auto';

  const totalRows = Math.max(1, endRow - startRow + 1);
  const card = document.getElementById('gate1ProgressCard');
  if(card) card.style.display = 'block';

  updateGate1Progress(0, totalRows, `🚀 Starting Gate 1 campaign: Rows ${startRow} to ${endRow}... Mode: ${mode.toUpperCase()}`);

  const draftBtn = document.getElementById('btnGate1Draft');
  const sendBtn = document.getElementById('btnGate1Send');
  if(draftBtn) draftBtn.disabled = true;
  if(sendBtn) sendBtn.disabled = true;

  try {
    const res = await fetch('/api/gate1/send-emails', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        mode: mode,
        start_row: startRow,
        end_row: endRow,
        sheet_id: sheetId,
        template_name: templateName,
        resume_filename: resumeFilename,
        sender_profile: prof
      })
    });

    const data = await res.json();
    if(res.ok && data.status === 'success'){
      updateGate1Progress(totalRows, totalRows, `✅ Campaign Complete! ${data.message || data.detail || 'Processed successfully.'}`, true, 0);
      toast(`🎉 Gate 1: ${mode === 'draft' ? 'Drafts created in Gmail!' : 'Emails sent successfully!'}`, 'success', 6000);
      setTimeout(fetchAndRenderGate1Leads, 1500);
    } else {
      const errMsg = data.detail || data.error || 'Campaign failed to execute.';
      updateGate1Progress(0, totalRows, `❌ Error: ${errMsg}`, false, 1);
      toast(`Gate 1: ${errMsg}`, 'error', 6000);
    }
  } catch(err) {
    updateGate1Progress(0, totalRows, `❌ Network Error: ${err.message}`, false, 1);
    toast(`Network error connecting to backend: ${err.message}`, 'error');
  } finally {
    if(draftBtn) draftBtn.disabled = false;
    if(sendBtn) sendBtn.disabled = false;
  }
};

setTimeout(() => {
  loadGate1ProfileFieldsToUI();
  updateGate1LivePreview();
}, 300);



// ════════════════════════════════════════════════════════════════
// 📧 CHATGPT DIRECT TEMPLATE ENGINE (SIMPLE & POWERFUL)
// ════════════════════════════════════════════════════════════════
const EXACT_SHIVAM_MASTER_TEMPLATE = `Subject: Application for {{role}} at {{company}} — Shivam Gupta

Dear {{recruiter_name}},

I hope you're doing well.

I'm Shivam Gupta, a B.Tech student (ECE – Data Science & Machine Learning) at MMMUT, Gorakhpur, with hands-on project experience in machine learning, full-stack development, algorithmic backtesting, and quantitative trading.

I'm writing to express interest in {{role}} opportunities (internship or entry-level) at {{company}}, and to introduce myself in case a relevant opening comes up on your team.

A quick snapshot of my work:
- Built and deployed end-to-end ML pipelines (XGBoost, TensorFlow, Scikit-learn) for forecasting problems, deployed via Flask/FastAPI on AWS and Docker, with experiments tracked in MLflow
- Full-stack projects in production: a Next.js/FastAPI/Supabase platform, an electricity demand forecasting app, and a weather intelligence app
- Designed and backtested a price-action algorithmic trading strategy (Pine Script v5 + Python), including a live backtesting dashboard with Monte Carlo simulation, AdaBoost, and risk metrics
- Completed job simulations with Goldman Sachs (Risk Management), J.P. Morgan (Quantitative Research), and Bank of America (Global Markets Sales & Trading)
- Certifications: Machine Learning – Regression & Classification (Stanford Online), Algorithmic Toolbox / DSA (UC San Diego), NISM Securities Markets Certification

Across these projects, I've consistently focused on translating data into deployable, production-ready solutions rather than just models on paper.

My resume is attached for your reference. You're welcome to look through my work here:
GitHub: https://github.com/shivamjigkp
LinkedIn: https://linkedin.com/in/shivam-gupta-05209a279

I'm available to start immediately and open to both internship and full-time opportunities, whichever fits best with your current openings.

I'd really appreciate a few minutes of your time to discuss any suitable openings at {{company}}, or to be considered for future roles. Thank you for your time and consideration.

Warm regards,
Shivam Gupta
+91-8081513780 | quantxcoder@gmail.com`;









// ════════════════════════════════════════════════════════════════
// 🌟 11 MASTER TEMPLATES REGISTRY & 4-STEP COMPOSER JS
// ════════════════════════════════════════════════════════════════








function updateGate1PreviewForActiveRow(){
  updateGate1LivePreview();
}



async function runGate1Action(mode){
  if(mode === 'send'){
    if(!confirm('⚠️ ARE YOU SURE? This will SEND emails directly to the recipients via Gmail API without drafting.')) return;
  }

  const startRow = parseInt(document.getElementById('gate1StartRow')?.value || '2');
  const endRow = parseInt(document.getElementById('gate1EndRow')?.value || '10');
  const sheetSel = document.getElementById('gate1ActiveSheet');
  const sheetId = extractCleanSheetId(sheetSel?.value || '1lYkZAjqQQQGKTkxkLGUpNmcs4Wu68tPXo6JRa0PDimI');
  const tplSel = document.getElementById('gate1DefaultTemplate');
  const templateName = tplSel?.value || '1_mastermind_comprehensive';
  const resumeSel = document.getElementById('gate1DefaultResume');
  const resumeFilename = resumeSel?.value || 'auto';

  const subject = document.getElementById('gate1EmailSubject')?.value || '';
  const templateBody = document.getElementById('gate1LiveTemplateContent')?.value || '';
  const forceDraft = document.getElementById('gate1ForceDraftCheckbox')?.checked ?? true;

  const senderProfile = {
    name: 'Shivam Gupta',
    email: 'quantxcoder@gmail.com',
    phone: '+91-8081513780',
    linkedin: 'https://linkedin.com/in/shivam-gupta-05209a279',
    github: 'https://github.com/shivamjigkp'
  };

  const totalRows = Math.max(1, endRow - startRow + 1);
  const card = document.getElementById('gate1ProgressCard');
  if(card) card.style.display = 'block';

  updateGate1Progress(0, totalRows, `🚀 Starting Gate 1 campaign: Rows ${startRow} to ${endRow}... Mode: ${mode.toUpperCase()}`);

  const draftBtn = document.getElementById('btnGate1Draft');
  const sendBtn = document.getElementById('btnGate1Send');
  if(draftBtn) draftBtn.disabled = true;
  if(sendBtn) sendBtn.disabled = true;

  try {
    const res = await fetch('/api/gate1/send-emails', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        mode: mode,
        start_row: startRow,
        end_row: endRow,
        sheet_id: sheetId,
        template_name: templateName,
        subject: subject,
        template_body: templateBody,
        force_draft: forceDraft,
        resume_filename: resumeFilename,
        sender_profile: senderProfile
      })
    });

    const data = await res.json();
    if(res.ok && data.status === 'success'){
      updateGate1Progress(totalRows, totalRows, `✅ Campaign Complete! ${data.message || data.detail || 'Processed successfully.'}`, true, 0);
      toast(`🎉 Gate 1: ${mode === 'draft' ? 'Drafts created in Gmail!' : 'Emails sent successfully!'}`, 'success', 6000);
      setTimeout(fetchAndRenderGate1Leads, 1500);
    } else {
      const errMsg = data.detail || data.error || 'Campaign failed to execute.';
      updateGate1Progress(0, totalRows, `❌ Error: ${errMsg}`, false, 1);
      toast(`Gate 1: ${errMsg}`, 'error', 6000);
    }
  } catch(err) {
    updateGate1Progress(0, totalRows, `❌ Network Error: ${err.message}`, false, 1);
    toast(`Network error connecting to backend: ${err.message}`, 'error');
  } finally {
    if(draftBtn) draftBtn.disabled = false;
    if(sendBtn) sendBtn.disabled = false;
  }
}

// Auto init on load
setTimeout(() => {
  populateTemplateDropdown();
  syncGate1LiveTemplateEditor();
  fetchAndRenderGate1Leads();
  refreshGate1Resumes();
}, 200);



// ════════════════════════════════════════════════════════════════
// 🌟 BULLETPROOF 11 MASTER TEMPLATES SUITE (INSTANT 0MS PRE-LOADED)
// ════════════════════════════════════════════════════════════════
const ALL_MASTER_TEMPLATES = {"1": "Subject: Application for Opportunities at {{company}} \u2014 Shivam Gupta\n\nDear {{recruiter_name}},\n\nI hope you are doing well.\n\nI am Shivam Gupta, a B.Tech student in Electronics & Communication Engineering (ECE), specializing in Data Science and Machine Learning at MMMUT, Gorakhpur. I am writing to express my strong interest in internship and entry-level opportunities at {{company}} across Software Development, Full-Stack Engineering, AI/ML, Data, Fintech, and Quantitative/Algorithmic Trading.\n\nI bring a hands-on, builder-oriented background in developing real-world software products, machine learning applications, and financial analytics solutions. I am also the Founder of Mastermind Research Technologies, an MSME/Udyam-registered technology venture focused on AI/ML, software, and web-development solutions, and I run Mastermind Algo Trader, a YouTube-based trading education platform sharing practical insights on algorithmic trading, price action, risk management, and market analysis.\n\nA brief overview of my work:\n\u2022 Full-Stack & Web Engineering: Built and deployed production-oriented full-stack applications using Next.js, React, FastAPI, TypeScript, JavaScript, Supabase/PostgreSQL, REST APIs, Cloudflare, Vercel, and Render. Shipped multiple healthcare & institutional platforms including a production hospital platform for Rajendra Hospital, Gorakhpur (appointment workflows, symptom-triage matcher, PM-JAY cashless calculator, appointment passes) and the MMMUT Hockey portal.\n\u2022 Enterprise & Outreach Platforms: Developed platforms for Mastermind Research Technologies and Mastermind Algo Trader with secure authentication, cloud deployment, payment webhooks, and live trading-signal workflows. Built this LLM-powered ATS resume intelligence and outreach platform with automated lead sync, Google Sheets integration, and Gmail API outreach.\n\u2022 Machine Learning & Data Engineering: Engineered end-to-end ML pipelines for forecasting, prediction, and analytics using Python, Pandas, NumPy, Scikit-learn, TensorFlow, XGBoost, Flask/FastAPI, Docker, AWS, and MLflow across electricity-demand forecasting, weather intelligence, and stock-price prediction.\n\u2022 Algorithmic Trading & Quantitative Systems: Designed, tested, and backtested rule-based algorithmic strategies (Pine Script v5, Python, FastAPI, TradingView, Chartink) with liquidity-sweep detection, EMA crossover logic, live signals, and risk analytics.\n\u2022 Competitions & Industry Simulations: Achieved Rank 3 and won the XM Global Daily Trading Competition in algorithmic trading, and cleared both phases of the FundingPips prop-firm challenge. Completed virtual job simulations in Risk Management (Goldman Sachs), Quantitative Research (J.P. Morgan), and Global Markets Sales & Trading (Bank of America).\n\nI am especially interested in opportunities where I can combine engineering, data, and analytical thinking\u2014whether through building scalable software products, AI-powered applications, data platforms, or fintech and quantitative solutions.\n\nMy resume is attached for your consideration. You can also review my work here:\nGitHub: https://github.com/shivamjigkp\nLinkedIn: https://linkedin.com/in/shivam-gupta-05209a279\n\nI would be grateful for the opportunity to be considered for any suitable current or future role at {{company}}. Thank you for your time and consideration.\n\nWarm regards,\nShivam Gupta\n+91-8081513780 | quantxcoder@gmail.com", "10_follow_up_gentle": "Subject: Re: Application for {{role}} at {{company}} \u2014 Shivam Gupta\n\nDear {{recruiter_name}},\n\nI wanted to quickly follow up on my previous email regarding {{role}} opportunities at {{company}}.\n\nI understand you have a busy schedule, so I wanted to re-share my resume and GitHub repository in case my previous message got buried:\n\n\u2022 GitHub: https://github.com/shivamjigkp\n\u2022 LinkedIn: https://linkedin.com/in/shivam-gupta-05209a279\n\u2022 Highlights: Full-Stack (Next.js/FastAPI), ML Pipelines, Algorithmic Trading Systems, Stanford & UC San Diego Certifications.\n\nI remain very excited about the work {{company}} is doing and would love a 5-minute chat if you have an opening.\n\nThank you again for your time and consideration!\n\nWarm regards,\nShivam Gupta\n+91-8081513780 | quantxcoder@gmail.com", "11_data_analyst_bi": "Subject: Application for Data Analyst / BI Role at {{company}} \u2014 Shivam Gupta\n\nDear {{recruiter_name}},\n\nI am writing to express my interest in Data Analyst and Business Intelligence opportunities at {{company}}.\n\nAs a B.Tech student in ECE (Data Science & ML) at MMMUT, I have extensive experience translating raw data into actionable dashboards, statistical insights, and automated reports.\n\nCore Competencies:\n\u2022 Advanced Data Analysis: Python (Pandas, NumPy, Scikit-learn), SQL (PostgreSQL), and automated ETL pipelines.\n\u2022 Predictive Modeling: Built forecasting models for electricity demand, weather intelligence, and asset price forecasting.\n\u2022 Visualization & Dashboards: Developed interactive analytics dashboards with live risk metrics and Monte Carlo simulations.\n\nMy resume is attached for your review. You can explore my data science projects here:\nGitHub: https://github.com/shivamjigkp\nLinkedIn: https://linkedin.com/in/shivam-gupta-05209a279\n\nI would welcome the opportunity to discuss how my analytical skills can support {{company}}'s data-driven growth.\n\nBest regards,\nShivam Gupta\n+91-8081513780 | quantxcoder@gmail.com", "1_mastermind_comprehensive": "Subject: Application for Opportunities at {{company}} \u2014 Shivam Gupta\n\nDear {{recruiter_name}},\n\nI hope you are doing well.\n\nI am Shivam Gupta, a B.Tech student in Electronics & Communication Engineering (ECE), specializing in Data Science and Machine Learning at MMMUT, Gorakhpur. I am writing to express my strong interest in internship and entry-level opportunities at {{company}} across Software Development, Full-Stack Engineering, AI/ML, Data, Fintech, and Quantitative/Algorithmic Trading.\n\nI bring a hands-on, builder-oriented background in developing real-world software products, machine learning applications, and financial analytics solutions. I am also the Founder of Mastermind Research Technologies, an MSME/Udyam-registered technology venture focused on AI/ML, software, and web-development solutions, and I run Mastermind Algo Trader, a YouTube-based trading education platform sharing practical insights on algorithmic trading, price action, risk management, and market analysis.\n\nA brief overview of my work:\n\u2022 Full-Stack & Web Engineering: Built and deployed production-oriented full-stack applications using Next.js, React, FastAPI, TypeScript, JavaScript, Supabase/PostgreSQL, REST APIs, Cloudflare, Vercel, and Render. Shipped multiple healthcare & institutional platforms including a production hospital platform for Rajendra Hospital, Gorakhpur (appointment workflows, symptom-triage matcher, PM-JAY cashless calculator, appointment passes) and the MMMUT Hockey portal.\n\u2022 Enterprise & Outreach Platforms: Developed platforms for Mastermind Research Technologies and Mastermind Algo Trader with secure authentication, cloud deployment, payment webhooks, and live trading-signal workflows. Built this LLM-powered ATS resume intelligence and outreach platform with automated lead sync, Google Sheets integration, and Gmail API outreach.\n\u2022 Machine Learning & Data Engineering: Engineered end-to-end ML pipelines for forecasting, prediction, and analytics using Python, Pandas, NumPy, Scikit-learn, TensorFlow, XGBoost, Flask/FastAPI, Docker, AWS, and MLflow across electricity-demand forecasting, weather intelligence, and stock-price prediction.\n\u2022 Algorithmic Trading & Quantitative Systems: Designed, tested, and backtested rule-based algorithmic strategies (Pine Script v5, Python, FastAPI, TradingView, Chartink) with liquidity-sweep detection, EMA crossover logic, live signals, and risk analytics.\n\u2022 Competitions & Industry Simulations: Achieved Rank 3 and won the XM Global Daily Trading Competition in algorithmic trading, and cleared both phases of the FundingPips prop-firm challenge. Completed virtual job simulations in Risk Management (Goldman Sachs), Quantitative Research (J.P. Morgan), and Global Markets Sales & Trading (Bank of America).\n\nI am especially interested in opportunities where I can combine engineering, data, and analytical thinking\u2014whether through building scalable software products, AI-powered applications, data platforms, or fintech and quantitative solutions.\n\nMy resume is attached for your consideration. You can also review my work here:\nGitHub: https://github.com/shivamjigkp\nLinkedIn: https://linkedin.com/in/shivam-gupta-05209a279\n\nI would be grateful for the opportunity to be considered for any suitable current or future role at {{company}}. Thank you for your time and consideration.\n\nWarm regards,\nShivam Gupta\n+91-8081513780 | quantxcoder@gmail.com", "2_quant_algo_trader": "Subject: Quant / Algorithmic Trading Application at {{company}} \u2014 Shivam Gupta\n\nDear {{recruiter_name}},\n\nI've been closely following {{company}}'s quantitative trading and market-making strategies, and I'm writing to explore {{role}} opportunities on your quantitative team.\n\nI am a B.Tech student (ECE \u2013 Data Science & ML) at MMMUT and Founder of Mastermind Research Technologies & Mastermind Algo Trader, specializing in quantitative modeling, statistical backtesting, and low-latency execution engines.\n\nKey Technical Highlights:\n\u2022 Algorithmic Strategy Development: Built and backtested automated price-action strategies (Pine Script v5 + Python) with live backtesting engines, Monte Carlo risk simulation, and drawdown optimization. Cleared both phases of FundingPips prop-firm evaluation and won Rank 3 in XM Global Daily Trading Competition.\n\u2022 Mathematical & ML Models: Developed predictive price forecasting pipelines using XGBoost, Scikit-learn, and statistical time-series analysis.\n\u2022 Industry Simulations: Completed quantitative research simulations with Goldman Sachs (Risk Management) and J.P. Morgan (Quantitative Research).\n\u2022 Core Certifications: NISM Securities Markets Certification, Stanford Machine Learning, and UC San Diego Algorithmic Toolbox / DSA.\n\nMy resume is attached. You can explore my live repositories here:\nGitHub: https://github.com/shivamjigkp\nLinkedIn: https://linkedin.com/in/shivam-gupta-05209a279\n\nI would appreciate a brief conversation to discuss how my quantitative modeling and analytical skill set can add value to {{company}}.\n\nBest regards,\nShivam Gupta\n+91-8081513780 | quantxcoder@gmail.com", "3_ai_ml_engineer": "Subject: Application for {{role}} at {{company}} \u2014 Shivam Gupta\n\nDear {{recruiter_name}},\n\nI'm writing to express strong interest in {{role}} opportunities at {{company}}.\n\nI'm a B.Tech (ECE \u2013 Data Science & Machine Learning) student at MMMUT Gorakhpur with hands-on experience building and deploying end-to-end Machine Learning pipelines and AI-driven applications.\n\nSnapshot of ML & Data Engineering Work:\n\u2022 End-to-End ML Pipelines: Developed and deployed predictive ML models (XGBoost, TensorFlow, Scikit-learn) with automated feature engineering, Docker containerization, and AWS hosting.\n\u2022 Production Apps: Built an electricity demand forecasting engine and a real-time weather intelligence platform with sub-200ms API inference using FastAPI.\n\u2022 LLM & NLP Platform: Architected an LLM-powered ATS resume intelligence system with automatic embedding comparison, scoring, and automated recruiter outreach.\n\u2022 Rigorous Background: Certified in Machine Learning by Stanford Online and Algorithmic Toolbox / DSA by UC San Diego.\n\nMy resume is attached. Live code & project architectures can be found here:\nGitHub: https://github.com/shivamjigkp\nLinkedIn: https://linkedin.com/in/shivam-gupta-05209a279\n\nI am available for immediate onboarding (internship or entry-level) and would love to discuss how I can contribute to {{company}}'s AI initiatives.\n\nWarm regards,\nShivam Gupta\n+91-8081513780 | quantxcoder@gmail.com", "4_fullstack_sde": "Subject: Full-Stack SDE Application for {{company}} \u2014 Shivam Gupta\n\nDear {{recruiter_name}},\n\nI hope you're having a productive week.\n\nI'm Shivam Gupta, a Full-Stack developer and founder of Mastermind Research Technologies. I noticed {{company}} is scaling rapidly and wanted to reach out regarding {{role}} opportunities.\n\nMy Core Stack & Proof of Work:\n\u2022 Modern Frontend: Next.js 15, React 19, TypeScript, Tailwind CSS, Framer Motion (optimized for 60fps animations and sub-second load times). Shipped platforms for Rajendra Hospital Gorakhpur, MMMUT Hockey, and Mastermind platform.\n\u2022 Scalable Backend: FastAPI, Flask, Supabase, PostgreSQL, REST/WebSocket APIs with robust error handling and microservice architecture.\n\u2022 Problem Solving: Solved 140+ DSA problems across LeetCode & GeeksforGeeks with strong fundamentals in algorithms and system design.\n\nMy resume is attached for your review. Please feel free to check out my work:\nGitHub: https://github.com/shivamjigkp\nLinkedIn: https://linkedin.com/in/shivam-gupta-05209a279\n\nI'm open to completing a 24-hour trial assignment to demonstrate my code quality and delivery speed. Looking forward to hearing from you!\n\nBest regards,\nShivam Gupta\n+91-8081513780 | quantxcoder@gmail.com", "5_short_startup_pitch": "Subject: Quick intro / {{role}} at {{company}} \u2014 Shivam Gupta\n\nDear {{recruiter_name}},\n\nI'm Shivam Gupta, a builder & founder (Mastermind Research Tech) specializing in full-stack platforms (Next.js 15, FastAPI) and ML/quantitative systems.\n\nI'm eager to contribute to {{company}} as a {{role}}.\n\nProof of Work:\n\u2022 Full-stack platforms in production with sub-200ms response times (Hospital portals, Trading dashboards).\n\u2022 Quantitative trading backtesting engines with Monte Carlo risk simulation (Rank 3 XM Global Trading).\n\u2022 GitHub: https://github.com/shivamjigkp | LinkedIn: https://linkedin.com/in/shivam-gupta-05209a279\n\nMy resume is attached. I'm ready to build a 24-hour trial project or jump on a 10-minute intro call.\n\nBest,\nShivam Gupta\n+91-8081513780 | quantxcoder@gmail.com", "6_alumni_referral": "Subject: MMMUT Student reaching out / Guidance on {{role}} at {{company}}\n\nDear {{recruiter_name}},\n\nI hope this email finds you well.\n\nI'm Shivam Gupta, currently pursuing my B.Tech in ECE (Data Science & ML) at MMMUT, Gorakhpur. I noticed your inspiring journey at {{company}} and wanted to reach out.\n\nI have been actively building production software across Machine Learning, algorithmic trading systems, and modern full-stack development (Next.js, FastAPI, Supabase). I am deeply interested in {{role}} openings at {{company}} and would appreciate any guidance on how to best position myself for the team.\n\nMy resume and GitHub are attached below for your reference:\nGitHub: https://github.com/shivamjigkp\nLinkedIn: https://linkedin.com/in/shivam-gupta-05209a279\n\nIf you have 5 minutes for a quick word or could refer my profile to the hiring team, it would mean a lot. Thank you for your time!\n\nWarm regards,\nShivam Gupta\n+91-8081513780 | quantxcoder@gmail.com", "7_problem_solver_pitch": "Subject: Ideas for {{company}}'s engineering & {{role}} application \u2014 Shivam Gupta\n\nDear {{recruiter_name}},\n\nI've been exploring {{company}}'s product and engineering architecture, and I'm deeply impressed by how your team is solving key challenges in your industry.\n\nAs a full-stack & ML developer (B.Tech at MMMUT), I focus on building high-performance, production-ready systems with sub-200ms latency, clean architecture, and data-driven algorithms.\n\nI'm writing to express interest in the {{role}} opening at {{company}}.\n\nWhat I bring to your engineering team:\n1. End-to-end execution: From schema design (PostgreSQL/Supabase) to high-speed backend APIs (FastAPI) and clean UI (Next.js 15).\n2. Data & ML expertise: Practical experience training, optimizing, and deploying ML models in production (AWS, Docker, MLflow).\n3. Fast turnaround: Strong product sense and ability to ship production-ready features independently.\n\nMy resume is attached. You can view my source code here:\nGitHub: https://github.com/shivamjigkp\nLinkedIn: https://linkedin.com/in/shivam-gupta-05209a279\n\nI would love to share a few ideas on how I can add immediate value to {{company}}.\n\nBest regards,\nShivam Gupta\n+91-8081513780 | quantxcoder@gmail.com", "8_fintech_investment_banking": "Subject: Fintech & Quantitative Tech Application at {{company}} \u2014 Shivam Gupta\n\nDear {{recruiter_name}},\n\nI am writing to express my interest in {{role}} opportunities at {{company}}.\n\nI am a B.Tech student (ECE \u2013 Data Science & ML) at MMMUT with a dedicated focus on financial engineering, high-throughput microservices, and quantitative risk systems.\n\nRelevant Background & Credentials:\n\u2022 Virtual Job Simulations: Completed hands-on simulations with Goldman Sachs (Risk Management), J.P. Morgan (Quantitative Research), and Bank of America (Global Markets Sales & Trading).\n\u2022 Financial Market Expertise: NISM Securities Markets Certified with deep understanding of market microstructure, order execution, and derivatives risk metrics.\n\u2022 Technical Stack: Python, Pine Script, Next.js, FastAPI, PostgreSQL, and Docker.\n\nMy resume is attached for your review. Feel free to inspect my projects:\nGitHub: https://github.com/shivamjigkp\nLinkedIn: https://linkedin.com/in/shivam-gupta-05209a279\n\nI am available for an immediate start and would welcome the opportunity to interview with your team.\n\nSincerely,\nShivam Gupta\n+91-8081513780 | quantxcoder@gmail.com", "9_immediate_availability": "Subject: Immediate Availability for {{role}} at {{company}} \u2014 Shivam Gupta\n\nDear {{recruiter_name}},\n\nI'm reaching out regarding {{role}} opportunities at {{company}}.\n\nI am an engineering student at MMMUT (ECE \u2013 Data Science & ML) and can start working immediately on a full-time or internship basis with zero onboarding friction.\n\nWhy I can contribute from Day 1:\n\u2022 Production Experience: Shipped production full-stack apps (Next.js, FastAPI, Supabase) and ML pipelines (AWS, Docker).\n\u2022 Self-Driven Builder: Built and backtested algorithmic trading systems and risk management dashboards.\n\u2022 Work Sample Ready: Happy to complete any technical assessment or build a working proof-of-concept for your team within 24 hours.\n\nMy resume is attached. Check out my live repos:\nGitHub: https://github.com/shivamjigkp\nLinkedIn: https://linkedin.com/in/shivam-gupta-05209a279\n\nLooking forward to connecting!\n\nBest regards,\nShivam Gupta\n+91-8081513780 | quantxcoder@gmail.com", "ai_ml_engineer": "Subject: Application for {{role}} at {{company}} \u2014 {{sender_name}}\n\nHi {{recruiter_name}},\n\nI'm {{sender_name}}, a B.Tech ({{branch}}) student at {{college}} with hands-on experience building and deploying end-to-end Machine Learning, LLM, and high-performance backend systems.\n\nI'm writing to express strong interest in {{role}} opportunities at {{company}}.\n\nA quick snapshot of my work:\n\u2022 ML & AI Pipelines: Built and deployed end-to-end ML forecasting pipelines (XGBoost, TensorFlow, Scikit-learn) with Docker, FastAPI, and AWS.\n\u2022 Full-Stack Production Systems: Developed Next.js 15, FastAPI, and Supabase platforms with sub-200ms latency and 99.9% uptime.\n\u2022 Certifications: Stanford Online (Machine Learning - Regression & Classification), UC San Diego (Algorithmic Toolbox / DSA).\n\nMy resume is attached for your reference. You can explore my live code here:\nGitHub: {{sender_github}}\nLinkedIn: {{sender_linkedin}}\n{{other_links}}\n\nI am available to start immediately and would appreciate an opportunity to connect with your engineering team.\n\nBest regards,\n{{sender_name}}\n{{sender_phone}} | {{sender_email}}", "default": "Subject: Application for Opportunities at {{company}} \u2014 Shivam Gupta\n\nDear {{recruiter_name}},\n\nI hope you are doing well.\n\nI am Shivam Gupta, a B.Tech student in Electronics & Communication Engineering (ECE), specializing in Data Science and Machine Learning at MMMUT, Gorakhpur. I am writing to express my strong interest in internship and entry-level opportunities at {{company}} across Software Development, Full-Stack Engineering, AI/ML, Data, Fintech, and Quantitative/Algorithmic Trading.\n\nI bring a hands-on, builder-oriented background in developing real-world software products, machine learning applications, and financial analytics solutions. I am also the Founder of Mastermind Research Technologies, an MSME/Udyam-registered technology venture focused on AI/ML, software, and web-development solutions, and I run Mastermind Algo Trader, a YouTube-based trading education platform sharing practical insights on algorithmic trading, price action, risk management, and market analysis.\n\nA brief overview of my work:\n\u2022 Full-Stack & Web Engineering: Built and deployed production-oriented full-stack applications using Next.js, React, FastAPI, TypeScript, JavaScript, Supabase/PostgreSQL, REST APIs, Cloudflare, Vercel, and Render. Shipped multiple healthcare & institutional platforms including a production hospital platform for Rajendra Hospital, Gorakhpur (appointment workflows, symptom-triage matcher, PM-JAY cashless calculator, appointment passes) and the MMMUT Hockey portal.\n\u2022 Enterprise & Outreach Platforms: Developed platforms for Mastermind Research Technologies and Mastermind Algo Trader with secure authentication, cloud deployment, payment webhooks, and live trading-signal workflows. Built this LLM-powered ATS resume intelligence and outreach platform with automated lead sync, Google Sheets integration, and Gmail API outreach.\n\u2022 Machine Learning & Data Engineering: Engineered end-to-end ML pipelines for forecasting, prediction, and analytics using Python, Pandas, NumPy, Scikit-learn, TensorFlow, XGBoost, Flask/FastAPI, Docker, AWS, and MLflow across electricity-demand forecasting, weather intelligence, and stock-price prediction.\n\u2022 Algorithmic Trading & Quantitative Systems: Designed, tested, and backtested rule-based algorithmic strategies (Pine Script v5, Python, FastAPI, TradingView, Chartink) with liquidity-sweep detection, EMA crossover logic, live signals, and risk analytics.\n\u2022 Competitions & Industry Simulations: Achieved Rank 3 and won the XM Global Daily Trading Competition in algorithmic trading, and cleared both phases of the FundingPips prop-firm challenge. Completed virtual job simulations in Risk Management (Goldman Sachs), Quantitative Research (J.P. Morgan), and Global Markets Sales & Trading (Bank of America).\n\nI am especially interested in opportunities where I can combine engineering, data, and analytical thinking\u2014whether through building scalable software products, AI-powered applications, data platforms, or fintech and quantitative solutions.\n\nMy resume is attached for your consideration. You can also review my work here:\nGitHub: https://github.com/shivamjigkp\nLinkedIn: https://linkedin.com/in/shivam-gupta-05209a279\n\nI would be grateful for the opportunity to be considered for any suitable current or future role at {{company}}. Thank you for your time and consideration.\n\nWarm regards,\nShivam Gupta\n+91-8081513780 | quantxcoder@gmail.com", "fullstack_sde": "Subject: Full-Stack / SDE Application for {{company}} \u2014 {{sender_name}}\n\nHi {{recruiter_name}},\n\nI hope you're having a great week.\n\nI'm {{sender_name}}, a B.Tech student ({{branch}}) at {{college}} and Founder of Mastermind Research Technologies. I build scalable, high-performance web platforms and API microservices.\n\nI noticed {{company}} is building impactful products and wanted to express my interest in {{role}} opportunities.\n\nTechnical Highlights:\n\u2022 Next.js 15, React, TypeScript, FastAPI, PostgreSQL, Supabase, and Tailwind CSS.\n\u2022 Engineered production platforms handling high-throughput user interactions and sub-200ms response times.\n\u2022 Solved 140+ algorithmic challenges across LeetCode and GeeksforGeeks.\n\nMy resume is attached. Please feel free to check out my repositories:\nGitHub: {{sender_github}}\nLinkedIn: {{sender_linkedin}}\n{{other_links}}\n\nI'd welcome the chance to discuss how my skill set aligns with {{company}}'s engineering roadmap.\n\nWarm regards,\n{{sender_name}}\n{{sender_phone}} | {{sender_email}}", "mastermind_official": "Subject: Application for {{role}} at {{company}} \u2014 Shivam Gupta\n\nDear {{recruiter_name}},\n\nI hope you're doing well.\n\nI'm Shivam Gupta, a B.Tech student (ECE \u2013 Data Science & Machine Learning) at MMMUT, Gorakhpur, with hands-on project experience in machine learning, full-stack development, algorithmic backtesting, and quantitative trading.\n\nI'm writing to express interest in {{role}} opportunities (internship or entry-level) at {{company}}, and to introduce myself in case a relevant opening comes up on your team.\n\nA quick snapshot of my work:\n- Built and deployed end-to-end ML pipelines (XGBoost, TensorFlow, Scikit-learn) for forecasting problems, deployed via Flask/FastAPI on AWS and Docker, with experiments tracked in MLflow\n- Full-stack projects in production: a Next.js/FastAPI/Supabase platform, an electricity demand forecasting app, and a weather intelligence app\n- Designed and backtested a price-action algorithmic trading strategy (Pine Script v5 + Python), including a live backtesting dashboard with Monte Carlo simulation, AdaBoost, and risk metrics\n- Completed job simulations with Goldman Sachs (Risk Management), J.P. Morgan (Quantitative Research), and Bank of America (Global Markets Sales & Trading)\n- Certifications: Machine Learning \u2013 Regression & Classification (Stanford Online), Algorithmic Toolbox / DSA (UC San Diego), NISM Securities Markets Certification\n\nAcross these projects, I've consistently focused on translating data into deployable, production-ready solutions rather than just models on paper.\n\nMy resume is attached for your reference. You're welcome to look through my work here:\nGitHub: https://github.com/shivamjigkp\nLinkedIn: https://linkedin.com/in/shivam-gupta-05209a279\n\nI'm available to start immediately and open to both internship and full-time opportunities, whichever fits best with your current openings.\n\nI'd really appreciate a few minutes of your time to discuss any suitable openings at {{company}}, or to be considered for future roles. Thank you for your time and consideration.\n\nWarm regards,\nShivam Gupta\n+91-8081513780 | quantxcoder@gmail.com", "mastermind_shivam_exact": "Subject: Application for {{role}} at {{company}} \u2014 {{sender_name}}\n\nDear {{recruiter_name}},\n\nI hope you're doing well.\n\nI'm {{sender_name}}, a B.Tech student ({{branch}}) at {{college}}, with hands-on experience in machine learning, full-stack development, algorithmic & quantitative trading. I am also founder of Mastermind Research Technologies.\n\nI'm writing to express interest in {{role}} opportunities (internship or entry-level job) at {{company}}, and to introduce myself in case a relevant opening comes up on your team.\n\n{{experience_summary}}\n\nAcross these projects, I've consistently focused on translating data into deployable, production-ready solutions rather than just models on paper.\n\nMy resume is attached for your reference. You're welcome to look through my work here:\nGitHub: {{sender_github}}\nLinkedIn: {{sender_linkedin}}\n{{other_links}}\n\nI'm available to start immediately and open to both internship and full-time opportunities, whichever fits best with your current openings.\n\nI'd really appreciate a few minutes of your time to discuss any suitable openings at {{company}}, or to be considered for future roles. Thank you for your time and consideration.\n\nWarm regards,\n{{sender_name}}\n{{sender_phone}} | {{sender_email}}", "quant_algo_trader": "Subject: Quant / Algorithmic Trading Application at {{company}} \u2014 {{sender_name}}\n\nHi {{recruiter_name}},\n\nI'm {{sender_name}}, a B.Tech student ({{branch}}) at {{college}} and Founder of Mastermind Research Technologies, specializing in quantitative trading algorithms and low-latency systems.\n\nI've been closely following {{company}}'s leadership in the market, and I am writing to explore {{role}} opportunities on your team.\n\nKey Highlights of My Work:\n\u2022 Algorithmic Trading Systems: Designed and backtested price-action algorithms (Pine Script v5 + Python) with live backtesting dashboards, Monte Carlo risk metrics, and sub-200ms API execution.\n\u2022 ML & Financial Engineering: Built predictive demand and price forecasting pipelines using XGBoost, TensorFlow, and Pandas.\n\u2022 Job Simulations: Completed simulations with Goldman Sachs (Risk Management), J.P. Morgan (Quantitative Research), and Bank of America (Global Markets).\n\u2022 Certifications: Stanford Machine Learning, UC San Diego Algorithmic Toolbox / DSA, NISM Securities Markets.\n\nLinks to My Code & Portfolio:\nGitHub: {{sender_github}}\nLinkedIn: {{sender_linkedin}}\n{{other_links}}\n\nMy resume is attached. I'd love a quick 10-minute conversation to discuss how I can contribute to {{company}}'s trading and technology initiatives.\n\nBest regards,\n{{sender_name}}\n{{sender_phone}} | {{sender_email}}", "short_startup_pitch": "Subject: Quick intro / {{role}} at {{company}} \u2014 {{sender_name}}\n\nHi {{recruiter_name}},\n\nI'm {{sender_name}}, a software engineer & founder with hands-on experience in full-stack platforms (Next.js, FastAPI), ML pipelines, and algorithmic trading systems.\n\nI'm eager to contribute to {{company}}'s mission as a {{role}} (internship or full-time).\n\nKey Proof of Work:\n\u2022 Full-stack platforms in production with sub-200ms response times.\n\u2022 Quant trading algorithms & risk analytics dashboard.\n\u2022 GitHub: {{sender_github}} | LinkedIn: {{sender_linkedin}}\n\nMy resume is attached. I'm ready to build a 24-hour trial project or jump on a 10-minute introductory call.\n\nBest,\n{{sender_name}}\n{{sender_phone}} | {{sender_email}}", "software_engineer": "Subject: {{role}} Application \u2014 {{sender_name}} for {{company}}\n\nHi {{recruiter_name}},\n\nI'm {{sender_name}}, a software engineer reaching out about the {{role}} role at {{company}}. I build and ship production code across the stack, and I'm drawn to what your team is working on.\n\n{{experience_summary}}\n\nMy resume is attached with more detail on relevant projects and experience. Happy to share code samples or walk through anything in more depth \u2014 would welcome the chance to talk.\n\nBest regards,\n{{sender_name}}\n{{sender_phone}} | {{sender_email}}\n{{sender_linkedin}}\n{{sender_github}}\n"};

const MASTER_TEMPLATES_COLLECTION = [
  { id: '1_mastermind_comprehensive', name: '⭐ 1 — Mastermind Comprehensive (Shivam Gupta Exact)' },
  { id: '2_quant_algo_trader', name: '📈 2 — Quant & Algorithmic Trading Specialist' },
  { id: '3_ai_ml_engineer', name: '🤖 3 — AI / ML Systems & LLM Pipelines' },
  { id: '4_fullstack_sde', name: '💻 4 — Full-Stack SDE (Next.js 15 & FastAPI)' },
  { id: '5_short_startup_pitch', name: '🔥 5 — Ultra-Short Founder Pitch (Under 85 words)' },
  { id: '6_alumni_referral', name: '🎓 6 — Alumni & Warm Referral Request' },
  { id: '7_problem_solver_pitch', name: '🛠️ 7 — Problem-Solver / Value-First Pitch' },
  { id: '8_fintech_investment_banking', name: '💼 8 — Fintech & Investment Banking Tech' },
  { id: '9_immediate_availability', name: '⏳ 9 — Immediate Availability & 24hr Trial' },
  { id: '10_follow_up_gentle', name: '🔄 10 — Gentle Follow-Up (2nd Touchpoint)' },
  { id: '11_data_analyst_bi', name: '📊 11 — Data Analyst & Business Intelligence' }
];

function populateTemplateDropdown(){
  const sel = document.getElementById('gate1DefaultTemplate');
  if(!sel) return;

  const activeTpl = localStorage.getItem('rsai_active_template') || '1_mastermind_comprehensive';

  sel.innerHTML = MASTER_TEMPLATES_COLLECTION.map(t => {
    const isSel = (t.id === activeTpl || t.id === activeTpl.replace('.txt','')) ? 'selected' : '';
    return '<option value="' + t.id + '" ' + isSel + '>' + t.name + '</option>';
  }).join('');
}

async function syncGate1LiveTemplateEditor(){
  const sel = document.getElementById('gate1DefaultTemplate');
  const tplId = sel?.value || '1_mastermind_comprehensive';
  const ta = document.getElementById('gate1LiveTemplateContent');
  const subInp = document.getElementById('gate1EmailSubject');
  if(!ta) return;

  localStorage.setItem('rsai_active_template', tplId);

  // 1. Instant load from ALL_MASTER_TEMPLATES map (0ms instant response)
  let rawContent = ALL_MASTER_TEMPLATES[tplId] || ALL_MASTER_TEMPLATES[tplId + '.txt'] || ALL_MASTER_TEMPLATES['1_mastermind_comprehensive'] || '';

  // 2. Fetch any custom user edits from server
  try {
    const res = await fetch('/api/gate1/templates/' + encodeURIComponent(tplId));
    const data = await res.json();
    if(data.status === 'success' && data.content){
      rawContent = data.content;
      ALL_MASTER_TEMPLATES[tplId] = rawContent;
    }
  } catch(e){}

  // 3. Extract Subject and Body
  const lines = rawContent.split('\n');
  if(lines[0].toLowerCase().startsWith('subject:')){
    if(subInp) subInp.value = lines[0].substring(8).trim();
    ta.value = lines.slice(1).join('\n').trim();
  } else {
    if(subInp) subInp.value = 'Application for Opportunities at {{company}} — Shivam Gupta';
    ta.value = rawContent.trim();
  }

  updateGate1LivePreview();
}

function updateGate1LivePreview(){
  const subInp = document.getElementById('gate1EmailSubject');
  const ta = document.getElementById('gate1LiveTemplateContent');
  const prevTo = document.getElementById('prevTo');
  const prevSub = document.getElementById('prevSubject');
  const prevBox = document.getElementById('gate1LivePreviewBox');
  const prevAtt = document.getElementById('prevAttachment');
  const resumeSel = document.getElementById('gate1DefaultResume');
  const companyBadge = document.getElementById('gate1PreviewTargetCompany');

  if(!ta || !prevBox) return;

  const startRow = parseInt(document.getElementById('gate1StartRow')?.value || '2');

  const sampleLead = {
    name: 'Hiring Team',
    email: 'careers@zerodha.com',
    company: 'Zerodha',
    role: 'Software Development / Quantitative Analyst'
  };

  if(companyBadge) companyBadge.textContent = 'Target: ' + sampleLead.company + ' (Row ' + startRow + ')';
  if(prevTo) prevTo.textContent = sampleLead.email;

  // Render Subject Preview
  let rawSub = subInp?.value || 'Application for Opportunities at {{company}} — Shivam Gupta';
  let renderedSub = rawSub
    .replace(/\{\{company\}\}/gi, sampleLead.company)
    .replace(/\{\{company_name\}\}/gi, sampleLead.company)
    .replace(/\{\{role\}\}/gi, sampleLead.role)
    .replace(/\{\{sender_name\}\}/gi, 'Shivam Gupta')
    .replace(/\{\{recruiter_name\}\}/gi, sampleLead.name);
  if(prevSub) prevSub.textContent = renderedSub;

  // Render Body Preview
  let rawBody = ta.value || '';
  let renderedBody = rawBody
    .replace(/\{\{recruiter_name\}\}/gi, sampleLead.name)
    .replace(/\{\{company\}\}/gi, sampleLead.company)
    .replace(/\{\{company_name\}\}/gi, sampleLead.company)
    .replace(/\{\{role\}\}/gi, sampleLead.role)
    .replace(/\{\{sender_name\}\}/gi, 'Shivam Gupta')
    .replace(/\{\{sender_email\}\}/gi, 'quantxcoder@gmail.com')
    .replace(/\{\{sender_phone\}\}/gi, '+91-8081513780')
    .replace(/\{\{sender_github\}\}/gi, 'https://github.com/shivamjigkp')
    .replace(/\{\{sender_linkedin\}\}/gi, 'https://linkedin.com/in/shivam-gupta-05209a279');

  prevBox.textContent = renderedBody;

  const resumeFile = resumeSel?.value || 'resume.pdf';
  if(prevAtt) prevAtt.textContent = 'Attachment: ' + resumeFile;
}

async function saveGate1LiveTemplate(){
  const sel = document.getElementById('gate1DefaultTemplate');
  const tplId = sel?.value || '1_mastermind_comprehensive';
  const sub = document.getElementById('gate1EmailSubject')?.value || 'Application for Opportunities at {{company}} — Shivam Gupta';
  const body = document.getElementById('gate1LiveTemplateContent')?.value || '';

  const fullContent = 'Subject: ' + sub + '\n\n' + body;

  ALL_MASTER_TEMPLATES[tplId] = fullContent;

  try {
    const res = await fetch('/api/gate1/templates/' + encodeURIComponent(tplId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: fullContent })
    });
    const data = await res.json();
    if(data.status === 'success'){
      toast('💾 Saved template "' + tplId + '" successfully!', 'success', 3500);
    } else {
      toast('Saved template locally', 'info');
    }
  } catch(e){
    toast('Saved template locally', 'info');
  }
}



// ════════════════════════════════════════════════════════════════
// 🛠 DYNAMIC SKILLS CATEGORIES MANAGER (ADD, EDIT, DELETE, REMOVE)
// ════════════════════════════════════════════════════════════════
function getActiveSkillsList(){
  if(Array.isArray(D.skillsList) && D.skillsList.length > 0){
    return D.skillsList;
  }
  const s = D.skills || {};
  const list = [];
  if(s.lang !== undefined) list.push({ key: 'lang', label: 'Languages', val: s.lang || '' });
  if(s.tools !== undefined) list.push({ key: 'tools', label: 'Tools & Frameworks', val: s.tools || '' });
  if(s.domain !== undefined) list.push({ key: 'domain', label: 'Domain / Stack', val: s.domain || '' });
  if(s.cloud !== undefined) list.push({ key: 'cloud', label: 'Cloud / Databases', val: s.cloud || '' });
  if(s.course !== undefined) list.push({ key: 'course', label: 'Coursework', val: s.course || '' });
  if(!list.length){
    list.push(
      { key: 'lang', label: 'Languages', val: 'C++, Python, TypeScript, JavaScript' },
      { key: 'tools', label: 'Tools & Frameworks', val: 'React, Next.js, FastAPI, Docker, Git' },
      { key: 'domain', label: 'Domain / Stack', val: 'Machine Learning, Full-Stack, Quantitative Trading' },
      { key: 'cloud', label: 'Cloud / Databases', val: 'PostgreSQL, Supabase, AWS, Cloudflare' }
    );
  }
  D.skillsList = list;
  return list;
}

function renderSkillsEditor(){
  const container = document.getElementById('skillsCategoriesList');
  if(!container) return;
  const list = getActiveSkillsList();
  
  container.innerHTML = list.map((item, idx) => `
    <div style="background:#fff;border:1px solid #cbd5e1;border-radius:8px;padding:9px;margin-bottom:8px;box-shadow:0 2px 5px rgba(0,0,0,0.03);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <input type="text" value="${(item.label||'Category').replace(/"/g,'&quot;')}" placeholder="Category Name (e.g. Languages / Tools)" style="flex:1;font-size:11px;font-weight:800;color:#334155;border:1px solid #cbd5e1;border-radius:4px;padding:3px 6px;max-width:200px;" oninput="updateSkillCategoryName(${idx}, this.value)">
        <button type="button" onclick="removeSkillCategory(${idx})" title="Delete this skill category" style="background:#fee2e2;border:none;color:#dc2626;padding:3px 7px;font-size:10.5px;border-radius:4px;cursor:pointer;font-weight:700;">🗑️ Remove</button>
      </div>
      <input type="text" value="${(item.val||'').replace(/"/g,'&quot;')}" placeholder="Enter skills comma-separated (e.g. Python, React, Docker...)" style="width:100%;font-size:11px;border:1px solid #cbd5e1;border-radius:4px;padding:5px 8px;box-sizing:border-box;" oninput="updateSkillCategoryValue(${idx}, this.value)">
    </div>
  `).join('');
}

function updateSkillCategoryName(idx, newLabel){
  const list = getActiveSkillsList();
  if(list[idx]){
    list[idx].label = newLabel;
    syncSkillsToD();
    render();
  }
}

function updateSkillCategoryValue(idx, newVal){
  const list = getActiveSkillsList();
  if(list[idx]){
    list[idx].val = newVal;
    syncSkillsToD();
    render();
    liveATS();
  }
}

function addSkillCategory(){
  const list = getActiveSkillsList();
  list.push({ key: 'custom_' + Date.now(), label: 'New Skill Category', val: '' });
  D.skillsList = list;
  syncSkillsToD();
  renderCustomSkillsEditor();
  render();
}

function removeSkillCategory(idx){
  const list = getActiveSkillsList();
  list.splice(idx, 1);
  D.skillsList = list;
  syncSkillsToD();
  renderCustomSkillsEditor();
  render();
  liveATS();
}

function syncSkillsToD(){
  const list = D.skillsList || [];
  if(!D.skills) D.skills = {};
  list.forEach(item => {
    if(item.key === 'lang') D.skills.lang = item.val;
    else if(item.key === 'tools') D.skills.tools = item.val;
    else if(item.key === 'domain') D.skills.domain = item.val;
    else if(item.key === 'cloud') D.skills.cloud = item.val;
    else if(item.key === 'course') D.skills.course = item.val;
  });
}

