// background.js - ASU CreateAI API integration (FULLY OPTIMIZED)
// 
// Optimization Strategy:
// 1. Use /search endpoint for RAG retrieval (fast, ~200-400ms)
// 2. Extract course data deterministically from RAG results (instant, ~5ms)
// 3. Only call /query (LLM) when absolutely necessary, with enable_search: false
//
// This avoids the duplicate RAG search that was happening before.

const API_CONFIG = {
  searchUrl: 'https://api-main-poc.aiml.asu.edu/search',  // RAG only
  queryUrl: 'https://api-main-poc.aiml.asu.edu/query'     // LLM only (when needed)
};

// Optimization settings
const CONFIG = {
  // Skip LLM entirely when we have good deterministic extraction
  skipLlmWhenDescriptionFound: true,
  // Minimum RAG score to trust results (your scores are typically 8-25)
  minRagScoreForTrust: 8.0,
  // Minimum description length to consider valid
  minDescriptionLength: 50,
  // Enable detailed timing logs
  enableTimingLogs: true
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getCourseData') {
    fetchCourseData(request.courseData).then(data => {
      sendResponse(data);
    });
    return true;
  }
});

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function calculateSimilarity(s1, s2) {
  if (!s1 || !s2) return 0;
  s1 = s1.toLowerCase().trim();
  s2 = s2.toLowerCase().trim();
  if (s1 === s2) return 1.0;

  const longer = s1.length > s2.length ? s1 : s2;
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
      if (i === 0) costs[j] = j;
      else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1))
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

// ============================================================================
// COURSE DESCRIPTION EXTRACTION (Deterministic - No LLM)
// ============================================================================

/**
 * Extract a specific course's description from a CSV chunk.
 * The chunks contain multiple courses, so we need to find the exact one.
 */
function extractCourseDescriptionFromChunk(chunkText, requestedSubject, requestedNumber) {
  if (!chunkText || typeof chunkText !== 'string') return null;

  const reqSubj = (requestedSubject || '').toUpperCase().trim();
  const reqNum = (requestedNumber || '').toString().replace(/[^0-9]/g, '');

  if (!reqSubj || !reqNum) return null;

  // Strategy 1: Find course by canonical key, then extract quoted description
  // Pattern: INSTITUTION::SUBJECT::NUMBER,...,"Description"
  const canonicalWithDesc = new RegExp(
    `[A-Z0-9 &\\-]+::${reqSubj}::${reqNum}[A-Za-z]?[,\\s]+` +
    `\\d+[,\\s]+` +                    // RulesUniqueIdentifier
    `[A-Z0-9 &\\-]+[,\\s]+` +          // Institution name
    `${reqSubj}[,\\s]+` +              // CourseSubject
    `${reqNum}[A-Za-z]?[,\\s]+` +      // CourseNumber
    `([^,]+)[,\\s]+` +                 // CourseLongTitle (group 1)
    `"([^"]{30,})"`,                   // CourseDescription (group 2)
    'i'
  );

  let match = chunkText.match(canonicalWithDesc);
  if (match && match[2] && !match[2].toLowerCase().includes('cannot find')) {
    return {
      description: match[2].trim(),
      title: match[1] ? match[1].trim() : '',
      method: 'canonical_pattern'
    };
  }

  // Strategy 2: More flexible CSV pattern
  const flexPattern = new RegExp(
    `${reqSubj},\\s*${reqNum}[A-Za-z]?,\\s*([^,]+),\\s*"([^"]{30,})"`,
    'i'
  );

  match = chunkText.match(flexPattern);
  if (match && match[2]) {
    return {
      description: match[2].trim(),
      title: match[1] ? match[1].trim() : '',
      method: 'flex_pattern'
    };
  }

  // Strategy 3: Find by canonical key, grab first long quoted string after it
  const canonicalPos = chunkText.search(new RegExp(`::${reqSubj}::${reqNum}[A-Za-z]?[,\\s]`, 'i'));
  if (canonicalPos !== -1) {
    // Search for description within next 2000 chars
    const searchWindow = chunkText.slice(canonicalPos, canonicalPos + 2000);

    // Find the course title first (after subject and number)
    const titleMatch = searchWindow.match(new RegExp(
      `${reqSubj}[,\\s]+${reqNum}[A-Za-z]?[,\\s]+([^,]{3,50})[,\\s]+`,
      'i'
    ));

    // Find quoted description
    const descMatch = searchWindow.match(/"([^"]{50,})"/);

    if (descMatch && descMatch[1]) {
      return {
        description: descMatch[1].trim(),
        title: titleMatch ? titleMatch[1].trim() : '',
        method: 'positional_pattern'
      };
    }
  }

  // Strategy 4: Segment-based - split chunks by course boundaries
  const courseKey = `::${reqSubj}::${reqNum}`;
  const segments = chunkText.split(/(?=[A-Z0-9 &\-]+::[A-Z]{2,6}::\d)/);

  for (const segment of segments) {
    if (segment.toUpperCase().includes(courseKey.toUpperCase())) {
      const descInSegment = segment.match(/"([^"]{50,})"/);
      if (descInSegment) {
        return {
          description: descInSegment[1].trim(),
          title: '',
          method: 'segment_pattern'
        };
      }
    }
  }

  return null;
}

/**
 * Extract ASU equivalent matches from the chunk.
 * The CSV contains match1_*, match2_*, match3_* columns with ASU course data.
 */
function extractAsuMatchesFromChunk(chunkText, requestedSubject, requestedNumber) {
  if (!chunkText) return [];

  const reqSubj = (requestedSubject || '').toUpperCase();
  const reqNum = (requestedNumber || '').toString().replace(/[^0-9]/g, '');

  const matches = [];
  const seen = new Set();

  // Find the section of text that belongs to our course
  const courseKey = `::${reqSubj}::${reqNum}`;
  const keyPos = chunkText.toUpperCase().indexOf(courseKey.toUpperCase());

  if (keyPos === -1) return [];

  // Get text from our course to the next course (or end)
  const nextCourseMatch = chunkText.slice(keyPos + courseKey.length).match(/\n[A-Z0-9 &\-]+::[A-Z]{2,6}::\d/);
  const endPos = nextCourseMatch ? keyPos + courseKey.length + nextCourseMatch.index : chunkText.length;
  const courseSection = chunkText.slice(keyPos, endPos);

  // Find ASU matches: ARIZONASTATEUNIVERSITY::SUBJ::NUM
  const asuPattern = /ARIZONASTATEUNIVERSITY::([A-Z]{2,6})::(\d{3}[A-Za-z]?)/gi;
  let m;

  while ((m = asuPattern.exec(courseSection)) !== null && matches.length < 3) {
    const subj = m[1].toUpperCase();
    const num = m[2].replace('.0', '');
    const key = `${subj}::${num}`;

    if (!seen.has(key)) {
      seen.add(key);

      // Try to extract title and description for this ASU course
      // Pattern: SUBJ,NUM,Title,"Description"
      const detailPattern = new RegExp(
        `${subj}[,\\s]+${num}[^,]*[,\\s]+([^,]+)[,\\s]+"([^"]+)"`,
        'i'
      );
      const details = courseSection.match(detailPattern);

      matches.push({
        subject: subj,
        number: num,
        title: details ? details[1].trim() : '',
        description: details ? details[2].trim() : ''
      });
    }
  }

  return matches;
}

// ============================================================================
// API CALLS
// ============================================================================

/**
 * Call /search endpoint - RAG retrieval only (fast)
 */
async function callRagSearch(token, query) {
  const payload = {
    query: query,
    search_params: {
      db_type: "opensearch",
      collection: "0cc3f744a8c740b0b36afb154d07ae24",
      top_k: 10,
      output_fields: ["content", "source_name", "chunk_number", "page_number"],
      retrieval_type: "neighbor"
    }
  };

  if (CONFIG.enableTimingLogs) console.time('RAG /search');

  const response = await fetch(API_CONFIG.searchUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  if (CONFIG.enableTimingLogs) console.timeEnd('RAG /search');

  if (!response.ok) {
    throw new Error(`RAG search failed: HTTP ${response.status}`);
  }

  const json = await response.json();

  // Normalize response to array of hits
  let hits = [];
  if (Array.isArray(json.response)) {
    hits = json.response;
  } else if (json.response?.response && Array.isArray(json.response.response)) {
    hits = json.response.response;
  } else if (Array.isArray(json.hits)) {
    hits = json.hits;
  }

  // Map to candidates
  const candidates = hits.map((h, idx) => ({
    id: `${h.source_name || 'unknown'}::${h.page_number || 0}::${h.chunk_number || idx}`,
    score: Number(h.score ?? h._score ?? 0),
    text: String(h.content || h._source?.content || '')
  }));

  candidates.sort((a, b) => b.score - a.score);

  console.log(`RAG returned ${candidates.length} results, top scores:`,
    candidates.slice(0, 3).map(c => c.score.toFixed(2)));

  return candidates;
}

/**
 * Call /query endpoint - LLM only, NO search (since we already have RAG results)
 */
async function callLlmQuery(token, query, contextFromRag) {
  // Simplified prompt - we just need course matching, not description extraction
  const systemPrompt = `You are a course matching assistant. Analyze the course data provided and return structured JSON.

CONTEXT FROM RAG SEARCH:
${contextFromRag.slice(0, 3000)}

Return ONLY this JSON structure:
{
  "catalog_status": "found",
  "subject": "BIOL",
  "number": "2251",
  "title": "Anatomy and Physiology I",
  "matches": {
    "match_1": { "subject": "BIO", "number": "201", "title": "Human Anatomy/Physiology I", "description": "..." },
    "match_2": { "subject": "", "number": "", "title": "", "description": "" },
    "match_3": { "subject": "", "number": "", "title": "", "description": "" }
  }
}`;

  const payload = {
    model_provider: "openai",
    model_name: "gpt5_2",
    model_params: {
      temperature: 0.0,
      max_tokens: 800,  // Reduced - we don't need long descriptions
      system_prompt: systemPrompt
    },
    query: query,
    enable_search: false,  // CRITICAL: Don't search again, we already have RAG results!
    response_format: { type: "json" }
  };

  if (CONFIG.enableTimingLogs) console.time('LLM /query');

  const response = await fetch(API_CONFIG.queryUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  if (CONFIG.enableTimingLogs) console.timeEnd('LLM /query');

  if (!response.ok) {
    throw new Error(`LLM query failed: HTTP ${response.status}`);
  }

  return await response.json();
}

// ============================================================================
// MAIN FETCH FUNCTION
// ============================================================================

/**
 * Main entry point - optimized for speed
 */
async function fetchCourseData(courseData) {
  const startTime = Date.now();

  try {
    const storage = await chrome.storage.local.get({ createaiToken: '' });
    const token = storage.createaiToken;

    if (!token) {
      return { success: false, error: 'API Token missing. Please set it in extension options.' };
    }

    const institution = courseData.institution || '';
    const subject = courseData.subject || '';
    const number = courseData.number || '';
    const title = courseData.title || '';

    const query = `${institution} ${subject} ${number} ${title}`.trim();
    console.log('='.repeat(60));
    console.log('Fetching course data for:', query);

    // ========================================
    // STEP 1: RAG Search (fast, ~200-400ms)
    // ========================================
    const ragCandidates = await callRagSearch(token, query);

    if (ragCandidates.length === 0) {
      console.log('No RAG results found - catalog not indexed');
      return createResponse('catalog_not_found', null, [], Date.now() - startTime);
    }

    // ========================================
    // STEP 2: Deterministic Extraction (instant, ~5ms)
    // ========================================
    if (CONFIG.enableTimingLogs) console.time('Deterministic Extraction');

    let bestExtraction = null;
    let bestMatches = [];
    let bestScore = 0;

    for (const candidate of ragCandidates) {
      // Check if this chunk contains our course
      const coursePattern = new RegExp(`::${subject}::${number}[A-Za-z]?\\b`, 'i');
      if (!coursePattern.test(candidate.text)) continue;

      const extracted = extractCourseDescriptionFromChunk(candidate.text, subject, number);

      if (extracted && extracted.description && extracted.description.length >= CONFIG.minDescriptionLength) {
        if (candidate.score > bestScore) {
          bestScore = candidate.score;
          bestExtraction = {
            ...extracted,
            sourceId: candidate.id,
            ragScore: candidate.score
          };
          bestMatches = extractAsuMatchesFromChunk(candidate.text, subject, number);
        }
      }
    }

    if (CONFIG.enableTimingLogs) console.timeEnd('Deterministic Extraction');

    // ========================================
    // STEP 3: Decide whether to call LLM
    // ========================================
    const hasGoodExtraction = bestExtraction &&
      bestExtraction.ragScore >= CONFIG.minRagScoreForTrust;

    if (CONFIG.skipLlmWhenDescriptionFound && hasGoodExtraction) {
      // FAST PATH: We have everything we need, skip LLM entirely
      console.log('✅ FAST PATH: Using deterministic extraction');
      console.log(`   Method: ${bestExtraction.method}`);
      console.log(`   RAG Score: ${bestExtraction.ragScore.toFixed(2)}`);
      console.log(`   Description length: ${bestExtraction.description.length}`);
      console.log(`   ASU Matches found: ${bestMatches.length}`);

      return createResponse('exact', bestExtraction, bestMatches, Date.now() - startTime, {
        path: 'fast_deterministic',
        llmSkipped: true,
        extractionMethod: bestExtraction.method
      });
    }

    // SLOW PATH: Need LLM for matching (rare - only when extraction fails)
    console.log('⚠️ SLOW PATH: Calling LLM for matching');

    // Prepare context for LLM from top RAG results
    const contextForLlm = ragCandidates.slice(0, 3)
      .map(c => c.text.slice(0, 1000))
      .join('\n---\n');

    const llmResponse = await callLlmQuery(token, query, contextForLlm);

    try {
      let responseText = llmResponse.response || '';
      responseText = responseText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      const parsed = JSON.parse(responseText);

      // Use deterministic description if available (it's more reliable)
      const description = bestExtraction?.description || 'Cannot find the course description';

      // Parse LLM matches
      const llmMatches = [];
      if (parsed.matches) {
        Object.values(parsed.matches).forEach(m => {
          if (m && m.subject && m.number) {
            llmMatches.push({
              subject: m.subject,
              number: String(m.number).replace('.0', ''),
              title: m.title || '',
              description: m.description || ''
            });
          }
        });
      }

      // Prefer deterministic matches over LLM matches (more reliable)
      const finalMatches = bestMatches.length > 0 ? bestMatches : llmMatches;

      return createResponse(
        parsed.catalog_status === 'found' ? 'exact' : 'no_match',
        bestExtraction || { description, title: parsed.title || '' },
        finalMatches,
        Date.now() - startTime,
        { path: 'slow_llm', llmSkipped: false }
      );

    } catch (parseError) {
      console.error('LLM response parse error:', parseError);

      // Fall back to deterministic results even if LLM fails
      if (bestExtraction) {
        return createResponse('exact', bestExtraction, bestMatches, Date.now() - startTime, {
          path: 'deterministic_after_llm_error'
        });
      }

      return { success: false, error: 'Failed to parse response' };
    }

  } catch (error) {
    console.error('Fetch error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Helper to create consistent response objects
 */
function createResponse(matchType, extraction, matches, elapsedMs, optimization = {}) {
  const response = {
    success: true,
    match_type: matchType,
    similarity: matchType === 'exact' ? 1.0 : (matchType === 'fuzzy' ? 0.8 : 0),
    reflected_course: {
      subject: extraction?.subject || '',
      number: extraction?.number || '',
      title: extraction?.title || ''
    },
    description: extraction?.description || 'Cannot find the course description',
    description_is_missing: !extraction?.description,
    matches: matches || [],
    _timing: {
      totalMs: elapsedMs,
      ...optimization
    }
  };

  console.log(`Total time: ${elapsedMs}ms | Path: ${optimization.path || 'unknown'}`);
  console.log('='.repeat(60));

  return response;
}

console.log('Triangulator extension (OPTIMIZED v2) loaded');
console.log('Config:', CONFIG);