// background.js - ASU CreateAI API integration

const API_CONFIG = {
  baseUrl: 'https://api-main-poc.aiml.asu.edu/query',
  searchUrl: 'https://api-main-poc.aiml.asu.edu/search',
  token: '' // Note: Bearer token is retrieved from chrome.storage.local at runtime; do not hardcode tokens here.
};

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getCourseData') {
    fetchCourseData(request.courseData).then(data => {
      sendResponse(data);
    });
    return true; // Keep message channel open for async response
  }
});

/**
 * Calculate similarity between two strings (0 to 1)
 */
function calculateSimilarity(s1, s2) {
  if (!s1 || !s2) return 0;
  s1 = s1.toLowerCase().trim();
  s2 = s2.toLowerCase().trim();

  if (s1 === s2) return 1.0;

  // Simple Jaro-Winkler or Levenshtein would be better, but for course codes
  // we can use a basic overlap + length penalty or similar.
  // Let's use a basic character-based similarity for now.
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  const longerLength = longer.length;
  if (longerLength === 0) return 1.0;

  const distance = editDistance(s1, s2);
  return (longerLength - distance) / parseFloat(longerLength);
}

function editDistance(s1, s2) {
  const costs = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0)
        costs[j] = j;
      else {
        if (j > 0) {
          let newValue = costs[j - 1];
          if (s1.charAt(i - 1) !== s2.charAt(j - 1))
            newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

/**
 * Validate institution name match with abbreviation handling
 * e.g. "AGRICULTURAL" matches "AG", "COLLEGE" matches "COLL"
 */
function validateInstitution(requested, reflected) {
  if (!requested || !reflected) return false;

  const normalize = (str) => str.toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const req = normalize(requested);
  const ref = normalize(reflected);

  // 1. Direct match
  if (req === ref) return true;

  // 2. Word overlapping with abbreviation check
  const reqWords = req.split(' ');
  const refWords = ref.split(' ');

  // Common abbreviations map
  const abbreviations = {
    'university': 'univ',
    'college': 'coll',
    'agricultural': 'ag',
    'technical': 'tech',
    'technology': 'tech',
    'institute': 'inst',
    'community': 'comm',
    'state': 'st',
    'north': 'n',
    'south': 's',
    'east': 'e',
    'west': 'w',
    'district': 'dist'
  };

  let matchCount = 0;

  // Check if enough words from the requested institution appear in the reflected one
  for (const w1 of reqWords) {
    if (w1.length <= 2 && !abbreviations[w1]) continue; // Skip small words like "of", "the" unless mapped

    for (const w2 of refWords) {
      if (w1 === w2) {
        matchCount++;
        break;
      }

      // Check abbreviations both ways
      const abbr1 = abbreviations[w1];
      const abbr2 = abbreviations[w2];

      if ((abbr1 && abbr1 === w2) || (abbr2 && abbr2 === w1)) {
        matchCount++;
        break;
      }

      // Check simple prefix match if word is long enough
      if (w1.length > 4 && w2.length > 4) {
        if (w1.startsWith(w2) || w2.startsWith(w1)) {
          matchCount++;
          break;
        }
      }
    }
  }

  // If we matched more than 50% of the significant words, consider it valid
  const significantReqWords = reqWords.filter(w => w.length > 2).length;
  // Guard against division by zero
  if (significantReqWords === 0) return true;

  return (matchCount / significantReqWords) >= 0.5;
}

function extractInstitutionFromContent(text) {
  if (!text || typeof text !== 'string') return '';
  const m = text.match(/([A-Z0-9 &\-]+)::([A-Z]{2,6})::(\d+[A-Za-z]*)/);
  if (m) return m[1].trim();
  return '';
}

/**
 * Call the /search endpoint and build rawCandidates
 */
async function runRagSearchAndBuildCandidates(query) {
  const storage = await chrome.storage.local.get({ createaiToken: '' });
  const token = storage.createaiToken;
  if (!token) throw new Error('Missing CreateAI token in chrome.storage.local');

  const searchPayload = {
    model_provider: "openai",
    model_name: "gpt5_2",
    model_params: { temperature: 0, max_tokens: 2000, system_prompt: "" },
    query,
    enable_search: true,
    search_params: {
      db_type: "opensearch",
      collection: "0cc3f744a8c740b0b36afb154d07ae24",
      top_k: 10,
      output_fields: ["content", "source_name", "chunk_number"],
      retrieval_type: "neighbor"
    }
  };

  const resp = await fetch('https://api-main-poc.aiml.asu.edu/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(searchPayload)
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '<no body>');
    console.error('RAG search HTTP error', resp.status, txt);
    throw new Error(`RAG search failed HTTP ${resp.status}`);
  }

  const json = await resp.json().catch(err => {
    console.error('RAG search: failed to parse JSON', err);
    throw new Error('RAG search returned invalid JSON');
  });

  // Defensive: normalize to an array of hits
  let hits = null;

  // Common shapes we expect:
  // 1) { response: [ ... ] }
  // 2) { response: { response: [ ... ] } }
  // 3) { hits: [ ... ] }
  // 4) { response: { hits: [ ... ] } }
  if (Array.isArray(json.response)) {
    hits = json.response;
    console.log('runRagSearch: using json.response (array), length:', hits.length);
  } else if (json.response && Array.isArray(json.response.response)) {
    hits = json.response.response;
    console.log('runRagSearch: using json.response.response, length:', hits.length);
  } else if (Array.isArray(json.hits)) {
    hits = json.hits;
    console.log('runRagSearch: using json.hits, length:', hits.length);
  } else if (json.response && Array.isArray(json.response.hits)) {
    hits = json.response.hits;
    console.log('runRagSearch: using json.response.hits, length:', hits.length);
  } else {
    // fallback: try to find the first array anywhere in the object (best-effort)
    const allArrays = Object.values(json).filter(v => Array.isArray(v));
    if (allArrays.length > 0) {
      hits = allArrays[0];
      console.warn('runRagSearch: falling back to first array found in response, length:', hits.length);
    } else {
      console.error('runRagSearch: unexpected response shape', json);
      throw new Error('RAG search returned unexpected response shape; no array of hits found');
    }
  }

  // Ensure hits is an array now
  if (!Array.isArray(hits)) {
    console.error('runRagSearch: hits is not an array', hits);
    throw new Error('RAG search returned non-array hits');
  }

  // Map hits to rawCandidates; be defensive with missing fields
  const rawCandidates = hits.map((h, idx) => {
    // The server sometimes returns items that are strings or objects with "content" etc.
    const content = (typeof h === 'string') ? h : (h.content || h._source?.content || '');
    const sourceName = h.source_name || h._source?.source_name || (h._index ? String(h._index) : 'unknown');
    const score = Number(h.score ?? h._score ?? 0);
    const page_number = h.page_number ?? (h._source?.page_number ?? 0);
    const chunk_number = h.chunk_number ?? (h._source?.chunk_number ?? idx);

    return {
      id: `${sourceName}::${page_number}::${chunk_number}`,
      metadata: {
        source_name: sourceName,
        chunk_number,
        page_number,
        // institution_normalized extraction will be done by enrichAndAggregate
        institution_normalized: null
      },
      score: score,
      text: String(content || '')
    };
  });

  // Sort by score descending to make order deterministic
  rawCandidates.sort((a, b) => (b.score - a.score));

  // Debug log top 3
  console.log('runRagSearch: built rawCandidates count=', rawCandidates.length,
    ' top scores:', rawCandidates.slice(0, 3).map(c => c.score));

  return rawCandidates;
}

/**
 * Fetch course data (description and matches) from CreateAI API
 */
// --- helper functions: transformer + description chooser ---

function tokenOverlap(a, b) {
  if (!a || !b) return 0.0;
  const re = /[A-Z0-9]+/g;
  const sa = new Set((a.toUpperCase().match(re) || []));
  const sb = new Set((b.toUpperCase().match(re) || []));
  if (sa.size === 0 || sb.size === 0) return 0.0;
  let inter = 0;
  sa.forEach(x => { if (sb.has(x)) inter++; });
  return inter / (new Set([...sa, ...sb]).size);
}

function extractFromText(text) {
  // returns partial metadata if found
  const out = {};
  if (!text || typeof text !== 'string') return out;
  // Pattern: INSTITUTION::SUBJECT::NUMBER (common in your CSVs)
  const m = text.match(/([A-Z0-9 &\-]+)::([A-Z]{2,6})::(\d+[A-Za-z]*)/);
  if (m) {
    out.institution_normalized = m[1].trim();
    out.subject = m[2].trim();
    out.number = m[3].trim();
  }
  // CSV header style fallback
  if (text.includes('CourseSubject') && text.includes('CourseNumber')) {
    // naive: try to find header line, then a following data line
    const lines = text.split(/\r?\n/);
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('CourseSubject') && lines[i].includes('CourseNumber')) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx >= 0 && headerIdx + 1 < lines.length) {
      const row = lines[headerIdx + 1].split(',');
      if (row.length >= 3) {
        out.subject = out.subject || row[0].trim();
        out.number = out.number || row[1].trim();
        out.title = out.title || row[2].trim();
      }
    }
  }
  // if not found, attempt to find first 3-digit number as number and preceding uppercase token as subject
  if (!out.number) {
    const numMatch = text.match(/(\b\d{3,4}[A-Za-z]?\b)/);
    if (numMatch) out.number = numMatch[1];
  }
  if (!out.subject && out.number) {
    // try capture a subject token immediately before number
    const subjMatch = text.match(/([A-Z]{2,6})\s+`?\d{3,4}/);
    if (subjMatch) out.subject = subjMatch[1];
  }
  // try to extract CourseDescription block
  const descMatch = text.match(/CourseDescription[^\n]*[:\-\n]\s*([^`]{50,2000})/i);
  if (descMatch) out.description = descMatch[1].trim();
  // fallback: long sentence heuristic
  if (!out.description) {
    const sentences = text.split(/(?<=[.?!])\s+/);
    for (const s of sentences) {
      if (s && s.trim().length >= 50) { out.description = out.description || s.trim(); break; }
    }
  }

  return out;
}

function normalizeScoreField(candidates) {
  // candidates array of { metadata: {...}, score: number, text: string }
  const rawScores = candidates.map(c => {
    const md = c.metadata || {};
    if (typeof md.norm_score === 'number') return md.norm_score;
    if (typeof c.score === 'number') return c.score;
    if (typeof md.cosine_score === 'number') return md.cosine_score;
    return 0.0;
  });
  let maxS = rawScores.length ? Math.max(...rawScores) : 1.0;
  if (maxS <= 0) maxS = 1.0;
  return candidates.map((c, idx) => {
    const s = rawScores[idx];
    // if already in 0..1, keep; else normalize by max
    let norm = (s >= 0 && s <= 1) ? s : (s / maxS);
    if (norm > 1) norm = 1.0;
    c.norm_score = norm;
    return c;
  });
}

function enrichAndAggregate(rawCandidates) {
  // rawCandidates: array of objects with possible fields:
  // { id, metadata, score, text }
  if (!Array.isArray(rawCandidates)) return [];

  // 1) enrich any missing metadata by parsing text
  const candidates = rawCandidates.map((c) => {
    const md = Object.assign({}, c.metadata || {});
    const text = c.text || c.content || '';
    if (!md.subject || !md.number || !md.institution_normalized || !md.description) {
      const parsed = extractFromText(text);
      md.institution_normalized = md.institution_normalized || (parsed.institution_normalized || '').toUpperCase();
      md.subject = (md.subject || parsed.subject || '').toUpperCase();
      md.number = md.number || parsed.number || '';
      md.title = md.title || parsed.title || '';
      md.description = md.description || parsed.description || '';
    }
    // parse number base/suffix
    const numStr = String(md.number || '');
    const m = numStr.match(/^(\d+)([A-Za-z]+)?$/);
    md.number_base = m ? m[1] : (md.number_base || '');
    md.number_suffix = m ? (m[2] || '').toUpperCase() : (md.number_suffix || '');
    return Object.assign({}, c, { metadata: md });
  });

  // 2) normalize scores to 0..1
  normalizeScoreField(candidates);

  // 3) aggregate by canonical key (inst + subject + number_base) if possible
  const groups = {};
  candidates.forEach(c => {
    const md = c.metadata || {};
    const inst = (md.institution_normalized || '').toUpperCase();
    const subject = (md.subject || '').toUpperCase();
    const base = String(md.number_base || '');
    const key = (inst && subject && base) ? `${inst}||${subject}||${base}` : (c.id || JSON.stringify(c).slice(0, 80));
    groups[key] = groups[key] || [];
    groups[key].push(c);
  });

  // 4) pick representative per group (highest norm_score) and choose longest description >=30 chars
  const final = Object.keys(groups).map(key => {
    const group = groups[key];
    group.sort((a, b) => (b.norm_score || 0) - (a.norm_score || 0));
    const rep = group[0];
    let descriptions = group.map(g => (g.metadata && g.metadata.description) || g.text || '').filter(Boolean);
    descriptions = descriptions.filter(d => d.length >= 30);
    const chosenDescription = descriptions.length ? descriptions.sort((a, b) => b.length - a.length)[0] : '';
    // ensure fields exist
    const md = Object.assign({}, rep.metadata || {});
    if (!md.description) md.description = chosenDescription;
    return {
      metadata: {
        institution_normalized: md.institution_normalized || '',
        subject: md.subject || '',
        number: md.number || '',
        number_base: md.number_base || '',
        number_suffix: md.number_suffix || '',
        title: md.title || '',
        description: md.description || ''
      },
      norm_score: rep.norm_score || 0,
      source_ids: group.map(g => g.id || null)
    };
  });

  // sort final by norm_score desc
  final.sort((a, b) => (b.norm_score || 0) - (a.norm_score || 0));
  return final;
}

// Choose a single description candidate from enriched 'rawCandidates'.
// rawCandidates: [{ id, text, score, metadata:{...} }, ...]
// requestedNumberBase: string like "2251"
function chooseDescriptionCandidate(rawCandidates, requestedNumberBase) {
  if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) return null;

  // Map candidate -> parsed course fields (best-effort)
  const candidates = rawCandidates.map(c => {
    const text = (c.text || '').replace(/\s+/g, ' ').trim();
    // try to find subject/number in the chunk (very conservative regex)
    const numMatch = text.match(/\b([A-Z]{2,5})\s*[:.-]?\s*(\d{2,4}[A-Za-z]?)\b/i);
    const subject = numMatch ? (numMatch[1] || '').toUpperCase() : (c.metadata.subject || '').toUpperCase();
    const number = numMatch ? (numMatch[2] || '') : (c.metadata.number || '');
    const numberBase = (String(number).match(/\d+/) || [])[0] || requestedNumberBase || '';
    return {
      ...c,
      parsed: { subject, number, numberBase },
      descriptionLength: text.length,
      text
    };
  });

  // Prefer same numberBase, higher score, longer description
  const withBase = candidates.filter(x => x.parsed.numberBase === String(requestedNumberBase));
  const pool = withBase.length ? withBase : candidates;

  // Sort by score desc, then by description length desc
  pool.sort((a, b) => (b.score - a.score) || (b.descriptionLength - a.descriptionLength));

  // Choose the top candidate only if it has a reasonable length and score
  const top = pool[0];
  if (!top) return null;

  // Thresholds for allowing injection
  const MIN_SCORE = 0.5;          // normalized score space (adjust as needed)
  const MIN_DESC_LENGTH = 40;     // avoid injecting tiny snippets

  if ((top.score >= MIN_SCORE) && (top.descriptionLength >= MIN_DESC_LENGTH)) {
    return { text: top.text, sourceId: top.id, score: top.score, parsed: top.parsed };
  }
  return null;
}

// --- end helpers ---

/**
 * Fetch course data (description and matches) from CreateAI API
 */
async function fetchCourseData(courseData) {
  try {
    // Get token from storage
    const storage = await chrome.storage.local.get({ createaiToken: '' });
    const token = storage.createaiToken;

    if (!token) {
      console.error('CreateAI API Error: No token found in storage.');
      return { success: false, error: 'API Token missing. Please set it in the extension options.' };
    }

    const institution = courseData.institution || '';
    const subject = courseData.subject || '';
    const number = courseData.number || '';
    const title = courseData.title || '';

    const query = `${institution} ${subject} ${number} ${title}`.trim();
    console.log('Fetching CreateAI data for query:', query);

    // If the caller provided rawCandidates / sources locally, OR if we need to fetch them
    let rawCandidates = courseData.rawCandidates || [];
    if (rawCandidates.length === 0) {
      console.log('No rawCandidates provided, performing dynamic RAG search...');
      rawCandidates = await runRagSearchAndBuildCandidates(query);
    }

    // Build auxiliary prompt information from RAG results
    let systemPromptAux = '';
    let chosen = null;
    if (Array.isArray(rawCandidates) && rawCandidates.length > 0) {
      chosen = chooseDescriptionCandidate(rawCandidates, number || '');
      if (chosen) {
        // Truncate to safe length (e.g., 2000 chars) to avoid context overflow
        const maxLen = 2000;
        const chosenText = chosen.text.length > maxLen ? chosen.text.slice(0, maxLen) : chosen.text;

        systemPromptAux = `

--DETERMINISTIC_DESCRIPTION_CANDIDATE--
${chosenText}
--END_DESCRIPTION_CANDIDATE--

DETERMINISTIC DESCRIPTION SELECTION:
If a description candidate is provided between the markers above, the assistant MUST use that text verbatim as the primary source for "input_course_description" when match rules allow. Do not invent, summarize, or replace it.
`;
      }
    }

    // Build payload and inject system prompt auxiliary if available
    // Build payload and inject system prompt auxiliary if available
    const baseSystemPrompt = `You are a course catalog validation and course matching assistant.

GOAL
You must determine:
- whether an institution catalog is indexed ("found" or "not_indexed"),
- whether the requested course is an exact match, a fuzzy match, or no match,
- return EXACTLY the JSON schema below, no extra text.

PRINCIPLES (strict)
- Do NOT hallucinate courses, institutions, subjects, numbers, or descriptions.
- Always use the structured candidate list provided by the retriever when available.
- If structured metadata is missing, use the FALLBACK PARSING rules below.
- Be deterministic: apply the numeric thresholds and selection rules exactly.
- Always return exactly 3 ASU matches (may be empty objects).

DETERMINISTIC DESCRIPTION SELECTION (HIGH PRIORITY):
If the system prompt contains a description enclosed between
--DETERMINISTIC_DESCRIPTION_CANDIDATE-- and --END_DESCRIPTION_CANDIDATE--
the assistant MUST:
  1) Use that candidate text verbatim for the "input_course_description" field
     if the final classification is EXACT, STRONG FUZZY, or FUZZY and the chosen
     description candidate matches the requested course number_base.
  2) NEVER invent or paraphrase that text when populating "input_course_description".
  3) If the assistant cannot apply the candidate due to contradictory reasoning,
     it MUST still return the original candidate text in a new field
     "candidate_description_used" inside the JSON output for audit.

INPUT CONTRACT (what the LLM expects)
You will be given:
- user_query: the original user text (e.g., "ANTELOPE VALLEY COLL BIOL 2251L ...")
- candidates: an ordered list (highest score first) of candidate objects. Each candidate SHOULD contain:
  - candidate.metadata.institution_normalized (string)
  - candidate.metadata.subject (string or "")
  - candidate.metadata.number (string or "")  // may include suffix like "2251L"
  - candidate.metadata.title (string or "")
  - candidate.metadata.description (string or "")
  - candidate.norm_score (float in 0.0–1.0)   // normalized score (retriever must provide or pipeline normalizes)

FALLBACK PARSING (if metadata missing)
- Attempt to extract institution, subject, number, title, description from candidate.text using:
  1. pattern INSTITUTION::SUBJECT::NUMBER or CSV headers (CourseSubject,CourseNumber,...)
  2. regex extraction of uppercase SUBJECT tokens and the nearest numeric token for number
- If parsing fails, leave fields empty and rely on title-similarity + scores.

NORMALIZATION
- requested_subject: uppercase alphabetic tokens from user_query
- requested_number: first numeric token or numeric+suffix token (use regex ^(\\d+)([A-Za-z]+)?$)
- requested_number_base = digits portion; requested_number_suffix = letter portion (uppercased)

SCORE USAGE
- Use candidate.norm_score (0–1). If missing, treat as 0 and prefer candidates with metadata.

DETERMINISTIC MATCH RULES (apply in order)
- Candidate set used = candidates that belong to the resolved institution (institution_normalized equals or token-fuzzy-match ≥ 70%).
- Choose the top candidate from that set by norm_score (tie-break by title token overlap).

Classification on top candidate:

1) EXACT MATCH
   - norm_score ≥ 0.90
   - AND (candidate.subject equals requested_subject OR requested_subject missing but title overlap ≥ 90%)
   - AND (candidate.number equals requested_number exactly OR candidate.number equals requested_number_base + same suffix)

2) STRONG FUZZY MATCH
   - 0.80 ≤ norm_score < 0.90
   - AND one of:
     - subject matches or is known abbreviation
     - |int(candidate.number_base) - int(requested_number_base)| ≤ 1
     - title token overlap ≥ 70%

3) FUZZY MATCH
   - 0.70 ≤ norm_score < 0.80
   - AND moderate subject/title similarity

4) NO MATCH (same institution)
   - norm_score < 0.70
   - OR no meaningful alignment

LAB / SUFFIX FALLBACK (generic)
- If requested_number_suffix exists (e.g., "L") and classification is NO_MATCH:
  - Look for any candidate in the institution where candidate.number_base == requested_number_base and candidate.norm_score ≥ 0.70.
  - If found, set classification = "fuzzy_lab_fallback" (treat as FUZZY, not EXACT) and populate subject/number/title with that candidate's base number (no suffix).
  - Only apply if title overlap ≥ 40% to avoid unrelated fallbacks.

POPULATING input_course_description (consistent rule)
- Populate input_course_description ONLY when classification == EXACT MATCH and candidate.description is non-empty and length ≥ 50 characters.
- Otherwise set input_course_description = "Cannot find the course description".
- (This ensures consistent behavior: descriptions are only returned when high confidence and actual text exists.)

ASU EQUIVALENT MATCHES
- Always return exactly three objects for matches.match_1..match_3.
- Prefer ASU equivalencies provided by candidate metadata. If unavailable, leave fields empty.
- Do NOT invent ASU courses.

OUTPUT JSON (STRICT — no extras)
Return ONLY this JSON object matching types exactly:

{
  "catalog_status": "found" | "not_indexed",
  "subject": "",          // string or empty
  "number": "",           // string or empty (store base number, no lab suffix)
  "title": "",            // string or empty
  "input_course_description": "", // either real description or "Cannot find the course description"
  "candidate_description_used": "", // verbatim candidate text used (for audit)
  "matches": {
    "match_1": { "subject": "", "number": "", "title": "", "description": "" },
    "match_2": { "subject": "", "number": "", "title": "", "description": "" },
    "match_3": { "subject": "", "number": "", "title": "", "description": "" }
  }
}`;
    const finalSystemPrompt = baseSystemPrompt + systemPromptAux;

    console.log('RAG chosen candidate:', chosen ? { id: chosen.sourceId, score: chosen.score, len: chosen.text.length } : null);
    console.log('Final system prompt contains candidate:', !!systemPromptAux);

    const payload = {
      "model_provider": "openai",
      "model_name": "gpt5_2",
      "model_params": {
        "temperature": 0.0,
        "max_tokens": 2000,
        "system_prompt": finalSystemPrompt,
        "top_k": 3
      },
      "query": query,
      "enable_search": true,
      "search_params": {
        "db_type": "opensearch",
        "collection": "0cc3f744a8c740b0b36afb154d07ae24",
        "output_fields": ["content", "source_name"]
      },
      "response_format": { "type": "json" }
    };

    const response = await fetch(API_CONFIG.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('CreateAI API error:', response.status, errorText);
      return { success: false, error: `API error: ${response.status}` };
    }

    const data = await response.json();
    console.log('CreateAI Raw Response:', data);

    // --- existing response parsing remains the same as before ---
    try {
      let responseText = data.response;
      responseText = responseText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      const innerResponse = JSON.parse(responseText);

      // Normalize description
      innerResponse.input_course_description = (innerResponse.input_course_description || '').trim();
      if (innerResponse.input_course_description.length < 10) {
        innerResponse.input_course_description = '';
      }

      let description = innerResponse.input_course_description;
      const reflectedSubject = innerResponse.subject || '';
      const reflectedNumber = innerResponse.number || '';
      const reflectedTitle = innerResponse.title || '';
      const catalogStatus = innerResponse.catalog_status || '';

      // Classification Logic (same as your existing logic)
      let matchType = 'no_match';
      let similarity = 0;
      let isMissingCourse = false;
      const lowerDesc = (description || '').toLowerCase();
      let isInstitutionValid = (catalogStatus === 'found');
      if (!isInstitutionValid && description && description.length > 50 && !lowerDesc.includes('cannot find')) {
        isInstitutionValid = true;
      }
      const isMissingCatalogKeyword = !description ||
        lowerDesc.includes('institution not found') ||
        lowerDesc.includes('catalog not found') ||
        lowerDesc.includes('not indexed') ||
        catalogStatus === 'not_indexed' ||
        catalogStatus === 'not_found';

      if (!isInstitutionValid || isMissingCatalogKeyword) {
        matchType = 'catalog_not_found';
      } else {
        isMissingCourse = lowerDesc.includes('cannot find') || (description || '').length < 5;
        const hasReflectedCourse = reflectedSubject && reflectedNumber;
        if (isMissingCourse && !hasReflectedCourse) {
          matchType = 'no_match';
        } else {
          const reqCourse = `${courseData.subject} ${courseData.number}`.toLowerCase().trim();
          const refCourse = `${reflectedSubject} ${reflectedNumber}`.toLowerCase().trim();
          similarity = calculateSimilarity(reqCourse, refCourse);
          if (similarity === 1.0) {
            matchType = 'exact';
          } else if (similarity >= 0.90) {
            matchType = 'strong_fuzzy';
          } else if (similarity >= 0.70) {
            matchType = 'fuzzy';
          } else {
            matchType = 'no_match';
          }
        }
      }

      const ALLOW_DESC_POP_SIMILARITY = 0.8;
      const allowPopulateDescription = (similarity >= ALLOW_DESC_POP_SIMILARITY);

      if ((!description || description.toLowerCase().includes('cannot find')) && chosen && allowPopulateDescription) {
        console.warn('LLM omitted description — filling from deterministic candidate.');

        // Attempt to extract cleaner description from raw chunk
        const extracted = extractFromText(chosen.text);
        let fallbackDesc = extracted.description;

        // If extraction failed or returned something too short, use refined raw text
        if (!fallbackDesc || fallbackDesc.length < 20) {
          fallbackDesc = chosen.text;
          // 1. If it looks like JSON, try to parse it
          // 2. Otherwise just take a reasonable substring
        }

        // Final sanity check on length
        if (fallbackDesc.length > 500) {
          // Heuristic: find first double newline or just truncate
          const split = fallbackDesc.split(/\n\s*\n/);
          if (split.length > 1 && split[0].length > 50) {
            fallbackDesc = split[0];
          } else {
            fallbackDesc = fallbackDesc.slice(0, 500) + '...';
          }
        }

        description = fallbackDesc;

        // Optionally inject an audit field
        innerResponse._injected_description = {
          sourceId: chosen.sourceId,
          score: chosen.score,
          injected_by: 'js_fallback',
          original_len: chosen.text.length,
          final_len: description.length
        };

        // Important: Update the missing flag so UI doesn't say "description missing"
        isMissingCourse = false;
      }

      console.log('LLM returned input_course_description length:', (innerResponse.input_course_description || '').length);
      if (innerResponse._injected_description) console.log('JS injected description from:', innerResponse._injected_description);

      console.log(`Classification: ${matchType} (Similarity: ${similarity.toFixed(2)}, AllowPopulate: ${allowPopulateDescription})`);

      const matches = [];
      if (matchType !== 'catalog_not_found' && innerResponse.matches) {
        Object.keys(innerResponse.matches).forEach(key => {
          const match = innerResponse.matches[key];
          if (match && match.subject && match.number) {
            let cleanNumber = String(match.number);
            if (cleanNumber.endsWith('.0')) {
              cleanNumber = cleanNumber.slice(0, -2);
            }
            matches.push({
              subject: match.subject,
              number: cleanNumber,
              title: match.title,
              description: match.description
            });
          }
        });
      }

      // Fallback: If no matches found by LLM, try to extract from description or text
      if (matches.length === 0 && matchType !== 'catalog_not_found') {
        const textToSearch = (description || '') + (chosen ? (' ' + chosen.text) : '');
        // Regex to find "ASU Match: ABC 123" patterns
        // Supporting formats: "ASU Match: ABC 123", "Equivalent: ABC 123", "ABC 123" if preceded by "ASU"
        const matchRegex = /(?:ASU(?:\s+Match)?|Equivalent)[:\s]+([A-Z]{3})\s+(\d{3}[A-Z]?)/gi;
        let m;
        const seen = new Set();
        while ((m = matchRegex.exec(textToSearch)) !== null) {
          const subj = m[1].toUpperCase();
          const num = m[2];
          const key = `${subj} ${num}`;
          if (!seen.has(key)) {
            seen.add(key);
            matches.push({
              subject: subj,
              number: num,
              title: 'ASU Equivalent', // We might not have the title, but better than nothing
              description: 'Extracted from catalog text.'
            });
          }
          if (matches.length >= 3) break;
        }
      }

      return {
        success: true,
        match_type: matchType,
        similarity: similarity,
        reflected_course: {
          subject: reflectedSubject,
          number: reflectedNumber,
          title: reflectedTitle
        },
        description: (allowPopulateDescription && description) ? description : 'Cannot find the course description',
        description_is_missing: !allowPopulateDescription || isMissingCourse,
        matches: matches
      };
    } catch (parseError) {
      console.error('Error parsing inner JSON response:', parseError);
      return { success: false, error: 'Failed to parse API response' };
    }

  } catch (error) {
    console.error('Fetch error:', error);
    return { success: false, error: error.message };
  }
}

console.log('Triangulator extension background script (CreateAI) loaded');