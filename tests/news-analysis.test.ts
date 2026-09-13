import 'dotenv/config';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { migrate } from '../server/db';
import { loadConfig } from '../server/config';
import { buildApp } from '../server/app';
import { parseAnalysis, summarizeNews } from '../server/providers/openai-news';
import { selectAnalysisSources } from '../server/news-analysis';
import type { NewsItem } from '../shared/types';

const news: NewsItem = {id:'news-1',title:'測試公司公告營收成長',url:'https://example.org/news/1',publishedAt:new Date(Date.now()-3600000).toISOString(),source:'測試媒體',kind:'news',securityIds:['TWSE:0050'],matchType:'exact'};
const sources=selectAnalysisSources([news],'TWSE:0050','all');
const point={text:'媒體報導營收成長，需核對正式公告。',sourceIds:['N1']};
const content={overview:point,facts:[point],implications:[point],watchpoints:[point]};

describe('OpenAI news grounding and safe requests',()=>{
  it('rejects fabricated citations and invalid structure',()=>{
    expect(()=>parseAnalysis({...content,overview:{...point,sourceIds:['https://evil.example']}},sources)).toThrow('引用');
    expect(()=>parseAnalysis({summary:'invented'},sources)).toThrow('格式');
  });
  it('sends public headlines only, uses requested model and does not store API responses remotely',async()=>{
    const fetcher=vi.fn(async(_url:unknown,init:any)=>{
      const body=JSON.parse(init.body);
      expect(body).toMatchObject({model:'gpt-5.6-luna',store:false,max_output_tokens:2600,reasoning:{effort:'none'}});
      expect(body.tools).toBeUndefined();expect(body.input).not.toContain(news.url);
      expect(JSON.parse(body.input).sources[0].title).toBe(news.title);
      return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(content)}]}],usage:{input_tokens:100,output_tokens:200}}));
    });
    const result=await summarizeNews('unit-test-key',{name:'測試ETF',symbol:'0050',market:'TWSE',assetType:'etf'},sources,fetcher as typeof fetch);
    expect(result.usage).toEqual({inputTokens:100,outputTokens:200});
    await expect(summarizeNews('unit-test-key',{name:'測試ETF',symbol:'0050',market:'TWSE',assetType:'etf'},sources,async()=>new Response('private provider body',{status:429}))).rejects.toThrow('額度');
  });
  it('rejects incomplete output and reserves ETF fund coverage amid constituent news',async()=>{
    await expect(summarizeNews('unit-test-key',{name:'ETF',symbol:'0050',market:'TWSE',assetType:'etf'},sources,async()=>Response.json({status:'incomplete',output:[]}))).rejects.toThrow('不完整');
    const crowded=Array.from({length:80},(_,i)=>({...news,id:String(i),url:`https://example.org/${i}`,relations:[{securityId:'TWSE:0050',kind:'constituent' as const}]}));
    const picked=selectAnalysisSources([...crowded,news],'TWSE:0050','all');
    expect(picked).toHaveLength(30);expect(picked.some(source=>source.relation==='direct')).toBe(true);
    expect(selectAnalysisSources([news],'TWSE:2330','all')).toEqual([]);
  });
});

const schema=`zhiyu_ai_test_${randomUUID().replaceAll('-','')}`;
const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:8,options:`-c search_path=${schema},public`});
const config=loadConfig({APP_MODE:'development',DATABASE_URL:process.env.DATABASE_URL,OPENAI_API_KEY:'unit-test-key',AI_DAILY_REQUEST_LIMIT:'2'});
let app:Awaited<ReturnType<typeof buildApp>>;
const generator=vi.fn(async()=>({content,usage:{inputTokens:100,outputTokens:200}}));
const headers={origin:'http://127.0.0.1:5173','content-type':'application/json'};
const path='/api/v1/finance/securities/TWSE%3A0050/news-analysis';
beforeAll(async()=>{
  await admin.query(`CREATE SCHEMA "${schema}"`);await migrate(pool);
  await pool.query("INSERT INTO securities(id,symbol,name,market,asset_type,source_url) VALUES('TWSE:0050','0050','測試ETF','TWSE','etf','https://example.org')");
  await pool.query('INSERT INTO news(id,data,published_at) VALUES($1,$2,$3)',[news.id,news,news.publishedAt]);
  app=await buildApp({pool,config,logger:false,newsSummarizer:generator,verifyIdentity:async request=>({email:request.headers['x-test-user']==='bob'?'bob@example.org':'alice@example.org',displayName:'Test',role:'member'})});
  await app.inject({method:'PUT',url:'/api/v1/finance/watchlist/TWSE%3A0050',headers,payload:{held:false,interested:true,group:'test'}});
});
afterAll(async()=>{await app?.close();await pool.end();if(!/^zhiyu_ai_test_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe schema');await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();});
describe('persisted analysis and cost boundaries',()=>{
  it('does not call OpenAI on GET or allow another user to analyze an untracked security',async()=>{
    expect((await app.inject({url:path,headers})).json()).toMatchObject({status:'empty',selectedCount:1});expect(generator).not.toHaveBeenCalled();
    expect((await app.inject({method:'POST',url:path,headers:{...headers,'x-test-user':'bob'},payload:{}})).statusCode).toBe(404);
    expect((await app.inject({method:'POST',url:path,headers:{...headers,origin:'https://evil.example'},payload:{}})).statusCode).toBe(403);
    expect(generator).not.toHaveBeenCalled();
  });
  it('coalesces concurrent generation and shares persisted cache across authorized users',async()=>{
    const replies=await Promise.all(Array.from({length:16},()=>app.inject({method:'POST',url:path,headers,payload:{}})));
    expect(replies.every(r=>r.statusCode===200)).toBe(true);expect(generator).toHaveBeenCalledTimes(1);
    const cached=(await app.inject({url:path,headers}));expect(cached.headers['cache-control']).toContain('no-store');expect(cached.json()).toMatchObject({status:'ready',analysis:{model:'gpt-5.6-luna',basis:'headlines'}});
    await app.inject({method:'PUT',url:'/api/v1/finance/watchlist/TWSE%3A0050',headers:{...headers,'x-test-user':'bob'},payload:{held:false,interested:true,group:'other'}});
    await app.inject({method:'POST',url:path,headers:{...headers,'x-test-user':'bob'},payload:{}});expect(generator).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT requests,input_tokens FROM ai_daily_usage')).rows[0]).toMatchObject({requests:1,input_tokens:'100'});
  });
  it('marks changed inputs stale, limits retries, and enforces shared daily cap atomically',async()=>{
    const before=generator.mock.calls.length;
    await pool.query("UPDATE news SET data=jsonb_set(data,'{title}',to_jsonb('測試新消息'::text))");
    expect((await app.inject({url:path,headers})).json().stale).toBe(true);
    expect((await app.inject({method:'POST',url:path,headers,payload:{}})).statusCode).toBe(429);
    await pool.query("UPDATE news_analysis SET last_attempt=now()-interval '20 minutes'");
    expect((await app.inject({method:'POST',url:path,headers,payload:{}})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:path,headers,payload:{scope:'direct'}})).statusCode).toBe(429);
    expect(generator.mock.calls.length-before).toBe(1);
    expect((await pool.query('SELECT requests FROM ai_daily_usage')).rows[0].requests).toBe(2);
  });
});
