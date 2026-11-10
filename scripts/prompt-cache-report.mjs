import fs from 'node:fs';
import path from 'node:path';

const SECTION_MARKERS = [
  '【主题】',
  '【大纲】',
  '【设定与人物】',
  '【前情摘要】',
  '【正文规模】',
  '【上一章标题】',
  '【上一章末尾】',
  '【资料库索引】',
  '【本次资料命中】',
  '【手动加入本次】',
  '【相关章节摘要】',
  '【选中文本】',
  '【待改段落】',
  '【指令】',
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function readLogs(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((file) => file.endsWith('.jsonl'))
    .sort();
  const events = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      events.push(event);
    }
  }
  return events.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
}

function collectRuns(events, filters = {}) {
  const runs = [];
  const active = new Map();
  for (const event of events) {
    if (event.evt === 'ai.run.start') {
      const run = {
        runId: event.runId || '',
        ts: event.ts || '',
        bookId: event.bookId || '',
        action: event.action || '',
        model: event.model || '',
        instruction: String(event.instruction || ''),
        requests: [],
        responses: [],
      };
      runs.push(run);
      active.set(run.model, run);
      continue;
    }

    if (event.evt === 'ai.run.done' || event.evt === 'ai.run.error' || event.evt === 'ai.run.abort') {
      if (event.runId) {
        for (const [model, run] of active) {
          if (run.runId === event.runId) active.delete(model);
        }
      }
      continue;
    }

    if (event.evt === 'ai.request' && event.stream === true) {
      const run = active.get(event.model);
      if (run) run.requests.push(event);
      continue;
    }

    if (event.evt === 'ai.response' && event.stream === true) {
      const run = active.get(event.model);
      if (run) run.responses.push(event);
    }
  }

  return runs.filter((run) => (
    (!filters.action || run.action === filters.action)
    && (!filters.model || run.model === filters.model)
    && (!filters.book || run.bookId === filters.book)
    && run.requests.length > 0
  ));
}

function firstUserMessage(run) {
  const messages = run.requests[0]?.messages;
  if (!Array.isArray(messages)) return '';
  return String(messages.find((message) => message.role === 'user')?.content || '');
}

function firstSystemMessage(run) {
  const messages = run.requests[0]?.messages;
  if (!Array.isArray(messages)) return '';
  return String(messages.find((message) => message.role === 'system')?.content || '');
}

function commonPrefixLength(a, b) {
  const length = Math.min(a.length, b.length);
  let index = 0;
  while (index < length && a.charCodeAt(index) === b.charCodeAt(index)) index += 1;
  return index;
}

function splitSections(text) {
  const positions = [];
  for (const marker of SECTION_MARKERS) {
    const at = text.indexOf(marker);
    if (at >= 0) positions.push({ marker, at });
  }
  positions.sort((a, b) => a.at - b.at);
  const sections = [];
  for (let i = 0; i < positions.length; i += 1) {
    const current = positions[i];
    const next = positions[i + 1];
    sections.push({
      marker: current.marker,
      text: text.slice(current.at, next ? next.at : text.length),
      at: current.at,
    });
  }
  return sections;
}

function sectionMap(text) {
  const map = new Map();
  for (const section of splitSections(text)) map.set(section.marker, section);
  return map;
}

function responseSummary(run) {
  const contentChars = run.responses.reduce((total, item) => (
    total + String(item.content || '').length
  ), 0);
  const toolNames = [];
  for (const response of run.responses) {
    for (const call of Array.isArray(response.toolCalls) ? response.toolCalls : []) {
      const name = call?.name || call?.function?.name;
      if (name) toolNames.push(name);
    }
  }
  return {
    requests: run.requests.length,
    responses: run.responses.length,
    contentChars,
    toolNames: [...new Set(toolNames)],
  };
}

function summaryLineStats(text) {
  const section = sectionMap(text).get('【前情摘要】');
  const lines = String(section?.text || '')
    .split('\n')
    .filter((line) => line.startsWith('- ['));
  const indexes = [];
  for (const line of lines) {
    const match = line.match(/^- \[(\d+)\]/);
    if (match) indexes.push(Number(match[1]));
  }
  return {
    count: lines.length,
    firstIndex: indexes[0] ?? null,
    lastIndex: indexes[indexes.length - 1] ?? null,
    indexes,
    lines,
  };
}

function commonLeadingLines(a, b) {
  const length = Math.min(a.length, b.length);
  let index = 0;
  while (index < length && a[index] === b[index]) index += 1;
  return index;
}

function formatRun(run) {
  const summary = responseSummary(run);
  return {
    ts: run.ts,
    runId: run.runId,
    model: run.model,
    bookId: run.bookId,
    action: run.action,
    instructionChars: run.instruction.length,
    requests: summary.requests,
    responses: summary.responses,
    responseChars: summary.contentChars,
    toolNames: summary.toolNames,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const logsDir = path.resolve(args.logs || 'data/logs');
  const action = String(args.action || 'chapter');
  const model = String(args.model || '');
  const book = String(args.book || '');
  const last = Math.max(2, Number(args.last) || 2);

  const events = readLogs(logsDir);
  let runs = collectRuns(events, { action, model, book });
  if (!runs.length) {
    console.error(`没有找到 action=${action} 的运行记录。`);
    process.exitCode = 1;
    return;
  }

  const targetBook = book || runs[runs.length - 1].bookId;
  const targetModel = model || runs[runs.length - 1].model;
  runs = runs.filter((run) => run.bookId === targetBook && run.model === targetModel);
  const selected = runs.slice(-last);

  if (selected.length < 2) {
    console.error('找到的有效运行少于两条，无法对比。');
    process.exitCode = 1;
    return;
  }

  const [runA, runB] = selected.slice(-2);
  const userA = firstUserMessage(runA);
  const userB = firstUserMessage(runB);
  const systemA = firstSystemMessage(runA);
  const systemB = firstSystemMessage(runB);
  const toolsA = JSON.stringify(runA.requests[0]?.tools || []);
  const toolsB = JSON.stringify(runB.requests[0]?.tools || []);
  const prefix = commonPrefixLength(userA, userB);
  const sectionA = sectionMap(userA);
  const sectionB = sectionMap(userB);
  const summaryA = summaryLineStats(userA);
  const summaryB = summaryLineStats(userB);
  const summarySetB = new Set(summaryB.lines);
  const summaryIdentical = summaryA.lines.filter((line) => summarySetB.has(line)).length;
  const summaryCommonPrefixLines = commonLeadingLines(summaryA.lines, summaryB.lines);
  const systemUserCommonChars = (systemA === systemB ? systemA.length : 0) + prefix;
  const systemUserTotalChars = systemA.length + userA.length;

  const requestInLog = Boolean(runA.requests[0]?.messages && runB.requests[0]?.messages);
  const responseInLog = runA.responses.length > 0 && runB.responses.length > 0;

  const comparison = {
    logsDir,
    action,
    bookId: targetBook,
    model: targetModel,
    requestInLog,
    responseInLog,
    runA: formatRun(runA),
    runB: formatRun(runB),
    sameSystem: systemA === systemB,
    sameTools: toolsA === toolsB,
    systemChars: { a: systemA.length, b: systemB.length },
    toolsChars: { a: toolsA.length, b: toolsB.length },
    userChars: { a: userA.length, b: userB.length },
    commonUserPrefixChars: prefix,
    commonUserPrefixPercent: {
      a: userA.length ? Number(((prefix / userA.length) * 100).toFixed(1)) : 0,
      b: userB.length ? Number(((prefix / userB.length) * 100).toFixed(1)) : 0,
    },
    systemUserCommonChars,
    systemUserCommonPercent: systemUserTotalChars
      ? Number(((systemUserCommonChars / systemUserTotalChars) * 100).toFixed(1))
      : 0,
    summary: {
      aCount: summaryA.count,
      bCount: summaryB.count,
      aRange: [summaryA.firstIndex, summaryA.lastIndex],
      bRange: [summaryB.firstIndex, summaryB.lastIndex],
      identicalLines: summaryIdentical,
      commonPrefixLines: summaryCommonPrefixLines,
    },
    firstDifference: (() => {
      if (prefix >= Math.min(userA.length, userB.length)) return null;
      const sections = splitSections(userA);
      let current = null;
      for (const section of sections) {
        if (section.at <= prefix) current = section;
        else break;
      }
      return {
        offset: prefix,
        section: current?.marker || '（材料块之前）',
        a: userA.slice(prefix, prefix + 80),
        b: userB.slice(prefix, prefix + 80),
      };
    })(),
    sections: SECTION_MARKERS.map((marker) => {
      const a = sectionA.get(marker);
      const b = sectionB.get(marker);
      return {
        marker,
        aChars: a?.text.length || 0,
        bChars: b?.text.length || 0,
        same: !a && !b ? true : Boolean(a && b && a.text === b.text),
      };
    }),
  };

  if (args.json) {
    console.log(JSON.stringify(comparison, null, 2));
    return;
  }

  console.log(`日志目录: ${logsDir}`);
  console.log(`书: ${targetBook} / 模型: ${targetModel} / action: ${action}`);
  console.log(`请求消息在日志里: ${requestInLog ? '是' : '否'}；响应内容在日志里: ${responseInLog ? '是' : '否'}`);
  console.log('');
  console.log('运行 A:', JSON.stringify(formatRun(runA)));
  console.log('运行 B:', JSON.stringify(formatRun(runB)));
  console.log('');
  console.log(`tools 相同（日志只记工具名）: ${comparison.sameTools}`);
  console.log(`system 相同: ${comparison.sameSystem} (${systemA.length} vs ${systemB.length} 字符)`);
  console.log(`user 字符数: ${userA.length} vs ${userB.length}`);
  console.log(`user 共同前缀: ${prefix} 字符（A ${comparison.commonUserPrefixPercent.a}% / B ${comparison.commonUserPrefixPercent.b}%）`);
  console.log(`system+user 共同前缀: ${systemUserCommonChars} / ${systemUserTotalChars} 字符（${comparison.systemUserCommonPercent}%）`);
  console.log(`第一个差异: ${comparison.firstDifference ? `第 ${comparison.firstDifference.offset} 字符，落在 ${comparison.firstDifference.section}` : 'user 完全一致'}`);
  console.log(`摘要条目: A=${comparison.summary.aCount} [${comparison.summary.aRange.join('–')}]，B=${comparison.summary.bCount} [${comparison.summary.bRange.join('–')}]，相同条目=${comparison.summary.identicalLines}，从开头连续相同=${comparison.summary.commonPrefixLines}`);
  console.log('');
  console.log('分段对比:');
  for (const section of comparison.sections) {
    console.log(`  ${section.marker.padEnd(12)} A=${String(section.aChars).padStart(6)} B=${String(section.bChars).padStart(6)} ${section.same ? '相同' : '不同'}`);
  }
  if (comparison.firstDifference && args['show-diff']) {
    console.log('');
    console.log('第一个差异附近（截断显示，避免打印整段正文）:');
    console.log(`  A: ${JSON.stringify(comparison.firstDifference.a)}`);
    console.log(`  B: ${JSON.stringify(comparison.firstDifference.b)}`);
  }
}

main();
