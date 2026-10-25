#!/usr/bin/env node
const specs = require('../question-specs.json');
const { normalizeOutput } = require('../lib/evaluation');

if (!process.argv.includes('--live')) {
  console.error('This makes real submissions to Judge0. Re-run with --live to opt in.');
  process.exit(2);
}
const base = (process.env.JUDGE0_URL || 'https://ce.judge0.com').replace(/\/$/, '');
const tokenHeader = process.env.JUDGE0_KEY ? { 'X-Auth-Token': process.env.JUDGE0_KEY } : {};
const languageIds = { java: Number(process.env.JUDGE0_JAVA_ID || 62), python: Number(process.env.JUDGE0_PYTHON_ID || 71) };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function javaSource(id, incorrect = false) {
  const statements = {
    '3': incorrect ? 'System.out.println(n > 0 ? a[0] : 0);' : 'long sum=0; for(long x:a)sum+=x; System.out.println(sum);',
    '5': incorrect ? 'long v=Long.MAX_VALUE; for(long x:a)v=Math.min(v,x); System.out.println(v);' : 'long v=Long.MIN_VALUE; for(long x:a)v=Math.max(v,x); System.out.println(v);',
    '6': incorrect ? 'long v=Long.MIN_VALUE; for(long x:a)v=Math.max(v,x); System.out.println(v);' : 'long v=Long.MAX_VALUE; for(long x:a)v=Math.min(v,x); System.out.println(v);',
    '13': incorrect ? 'for(int i=0;i<n;i++)System.out.print(a[i]+(i+1<n?" ":""));' : 'for(int i=n-1;i>=0;i--)System.out.print(a[i]+(i>0?" ":""));',
    '14': incorrect ? 'System.out.println(-1);' : 'int ans=-1; for(int i=0;i<n;i++)if(a[i]==key){ans=i;break;} System.out.println(ans);',
    '15': incorrect ? 'System.out.println(false);' : 'boolean found=false; for(long x:a)if(x==key)found=true; System.out.println(found);',
    '17': incorrect ? 'System.out.println("Positive = 0, Negative = 0, Zero = 0");' : 'int p=0,m=0,z=0; for(long x:a){if(x>0)p++;else if(x<0)m++;else z++;} System.out.println("Positive = "+p+", Negative = "+m+", Zero = "+z);',
    '18': incorrect ? 'for(int i=0;i<n;i++)System.out.print(a[i]+(i+1<n?" ":""));' : 'for(int i=0;i<n;i++)System.out.print((a[i]*2)+(i+1<n?" ":""));',
    '22': incorrect ? 'System.out.println(false);' : 'boolean found=false; for(int i=0;i<n;i++)for(int j=i+1;j<n;j++)if(a[i]+a[j]==target)found=true; System.out.println(found);',
    '25': incorrect ? 'System.out.println(true);' : 'boolean sorted=true; for(int i=1;i<n;i++)if(a[i-1]>a[i])sorted=false; System.out.println(sorted);'
  };
  const search = ['14','15'].includes(id);
  const pair = id === '22';
  return `import java.util.*;\npublic class Main { public static void main(String[] args) { Scanner s=new Scanner(System.in); ${pair ? 'int n=s.nextInt(); long target=s.nextLong();' : 'int n=s.nextInt();'} long[] a=new long[n]; for(int i=0;i<n;i++)a[i]=s.nextLong(); ${search ? 'long key=s.nextLong();' : ''} ${statements[id]} } }`;
}

function pythonSource(id, incorrect = false) {
  const statements = {
    '3': incorrect ? 'print(a[0])' : 'print(sum(a))',
    '5': incorrect ? 'print(min(a))' : 'print(max(a))',
    '6': incorrect ? 'print(max(a))' : 'print(min(a))',
    '13': incorrect ? 'print(*a)' : 'print(*reversed(a))',
    '14': incorrect ? 'print(-1)' : 'print(a.index(key) if key in a else -1)',
    '15': incorrect ? 'print("false")' : 'print(str(key in a).lower())',
    '17': incorrect ? 'print("Positive = 0, Negative = 0, Zero = 0")' : 'print(f"Positive = {sum(x>0 for x in a)}, Negative = {sum(x<0 for x in a)}, Zero = {sum(x==0 for x in a)}")',
    '18': incorrect ? 'print(*a)' : 'print(*(x*2 for x in a))',
    '22': incorrect ? 'print("false")' : 'print(str(any(a[i]+a[j]==target for i in range(n) for j in range(i+1,n))).lower())',
    '25': incorrect ? 'print("true")' : 'print(str(all(a[i-1]<=a[i] for i in range(1,n))).lower())'
  };
  const search = ['14','15'].includes(id);
  const pair = id === '22';
  return `import sys\nd=list(map(int,sys.stdin.buffer.read().split()))\n${pair ? 'n,target=d[0],d[1]; a=d[2:2+n]' : 'n=d[0]; a=d[1:1+n]'}\n${search ? 'key=d[1+n]' : ''}\n${statements[id]}\n`;
}

async function submit(languageId, source, input = '', limits = {}) {
  const headers = { 'Content-Type': 'application/json', ...tokenHeader };
  const payload = JSON.stringify({
    language_id: languageId,
    source_code: Buffer.from(source).toString('base64'),
    stdin: Buffer.from(input).toString('base64'),
    cpu_time_limit: limits.cpu || 3,
    wall_time_limit: limits.wall || 6,
    ...(limits.memory ? { memory_limit: limits.memory } : {})
  });
  let response;
  for (let retry = 0; retry < 5; retry++) {
    try {
      response = await fetch(`${base}/submissions?base64_encoded=true&wait=false`, { method: 'POST', headers, signal: AbortSignal.timeout(15000), body: payload });
    } catch (error) {
      if (retry === 4) throw error;
      await pause(1000 * (retry + 1));
      continue;
    }
    if (response.ok) break;
    const responseText = await response.text();
    if (![429, 500, 502, 503, 504].includes(response.status) || retry === 4) throw Error(`Judge0 create returned HTTP ${response.status}: ${responseText}`);
    await pause(1000 * (retry + 1));
  }
  if (!response?.ok) throw Error('Judge0 did not accept the code after retries.');
  const { token } = await response.json();
  for (let attempt = 0; attempt < 60; attempt++) {
    await pause(1000);
    let resultResponse;
    for (let retry = 0; retry < 4; retry++) {
      resultResponse = await fetch(`${base}/submissions/${token}?base64_encoded=true&fields=stdout,stderr,compile_output,status,time,memory`, { headers, signal: AbortSignal.timeout(15000) });
      if (resultResponse.ok) break;
      if (![429, 500, 502, 503, 504].includes(resultResponse.status) || retry === 3) throw Error(`Judge0 poll returned HTTP ${resultResponse.status}`);
      await pause(1000 * (retry + 1));
    }
    const result = await resultResponse.json();
    if (result.status && ![1, 2].includes(result.status.id)) {
      for (const field of ['stdout', 'stderr', 'compile_output']) if (result[field]) result[field] = Buffer.from(result[field], 'base64').toString('utf8');
      return result;
    }
  }
  throw Error('Judge0 polling timed out');
}

async function runWithLimit(items, limit, worker) {
  let cursor = 0, failed = false;
  const workers = Array.from({ length: limit }, async () => {
    while (!failed) {
      const index = cursor++;
      if (index >= items.length) return;
      try { await worker(items[index], index); }
      catch (error) { failed = true; throw error; }
    }
  });
  await Promise.all(workers);
}

(async () => {
  let checked = 0;
  const cases = Object.entries(specs).flatMap(([id, suite]) => [...suite.sampleTests, ...suite.hiddenTests].map(item => ({ id, item })));
  const languagesToVerify = process.argv.includes('--python-only') ? [['python', languageIds.python]] : Object.entries(languageIds);
  for (const [language, languageId] of languagesToVerify) {
    const jobs = cases.map(test => ({ ...test, language }));
    await runWithLimit(jobs, 1, async ({ id, item, language: lang }) => {
      const result = await submit(languageIds[lang], lang === 'java' ? javaSource(id) : pythonSource(id), item.input);
      const actual = normalizeOutput(result.stdout || '');
      const expected = normalizeOutput(item.expectedOutput);
      if (result.status?.description !== 'Accepted' || actual !== expected) {
        throw Error(`${lang} Q${id} failed: ${result.status?.description}; expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}\n${result.compile_output || result.stderr || ''}`);
      }
      checked++;
      if (checked % 10 === 0) console.log(`Verified ${checked}/${cases.length * 2} correct-code test executions`);
    });
  }

  for (const [id, suite] of Object.entries(specs)) {
    const candidate = suite.hiddenTests.find(item => normalizeOutput((() => {
      const data = item.input.trim().split(/\s+/).map(Number);
      if (id === '3') return String(data[1]);
      if (id === '5') return String(Math.min(...data.slice(1, data[0] + 1)));
      if (id === '6') return String(Math.max(...data.slice(1, data[0] + 1)));
      if (id === '13') return data.slice(1, data[0] + 1).join(' ');
      if (id === '14') return '-1';
      if (id === '15' || id === '22') return 'false';
      if (id === '17') return 'Positive = 0, Negative = 0, Zero = 0';
      if (id === '18') return data.slice(1, data[0] + 1).join(' ');
      if (id === '25') return 'true';
      return '';
    })()) !== normalizeOutput(item.expectedOutput));
    if (!candidate) throw Error(`No hidden test catches the flawed implementation for Q${id}`);
    const result = await submit(languageIds.java, javaSource(id, true), candidate.input);
    if (result.status?.description !== 'Accepted' || normalizeOutput(result.stdout || '') === normalizeOutput(candidate.expectedOutput)) {
      throw Error(`The deliberately flawed Java solution was not detected for Q${id}`);
    }
  }
  console.log(`Verified 10 deliberately flawed Java implementations against question-specific tests.`);

  const compile = await submit(languageIds.java, 'public class Main { this is not valid Java }', '');
  if (!/Compilation Error/i.test(compile.status?.description || '')) throw Error(`Compile-error probe returned ${compile.status?.description}`);
  const runtime = await submit(languageIds.java, 'public class Main { public static void main(String[] a) { int[] x=new int[1]; System.out.println(x[2]); } }', '');
  if (!/Runtime Error/i.test(runtime.status?.description || '')) throw Error(`Runtime probe returned ${runtime.status?.description}`);
  const timeout = await submit(languageIds.java, 'public class Main { public static void main(String[] a) { while(true){} } }', '', { cpu: 1, wall: 3 });
  if (!/Time Limit Exceeded/i.test(timeout.status?.description || '')) throw Error(`Timeout probe returned ${timeout.status?.description}`);
  console.log(`Verified ${checked} correct Java/Python executions, 10 flawed Java solutions, compile error, runtime error, and time limit via ${base}.`);
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
