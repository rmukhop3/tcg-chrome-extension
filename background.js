// background.js - ASU CreateAI API integration (OPTIMIZED v3.2)
// 
// Key fix: Proper course number suffix handling
// - BIOL 2251L (lab) should NOT be exact match with BIOL 2251 (lecture)
// - Must compare FULL course number including suffix
// - Lab courses without lab data should be fuzzy match at best

const API_CONFIG = {
  searchUrl: 'https://api-main-poc.aiml.asu.edu/search',
  queryUrl: 'https://api-main-poc.aiml.asu.edu/query'
};

const CONFIG = {
  skipLlmWhenExactMatch: true,
  skipLlmWhenCatalogNotFound: true,
  minRagScoreForTrust: 8.0,
  minDescriptionLength: 50,
  enableTimingLogs: true,

  catalogNotFoundThresholds: {
    maxTopScore: 12.0,
    minInstitutionMatchRatio: 0.4
  }
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
// SIMILARITY & MATCHING UTILITIES
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

/**
 * Parse course number into base and suffix
 * "2251L" -> { base: "2251", suffix: "L", full: "2251L" }
 * "2251" -> { base: "2251", suffix: "", full: "2251" }
 */
function parseCourseNumber(number) {
  const numStr = (number || '').toString().trim().toUpperCase();
  const match = numStr.match(/^(\d+)([A-Z]*)$/);

  if (match) {
    return {
      base: match[1],
      suffix: match[2] || '',
      full: numStr
    };
  }

  return {
    base: numStr.replace(/[^0-9]/g, ''),
    suffix: numStr.replace(/[0-9]/g, '').toUpperCase(),
    full: numStr
  };
}

/**
 * Classify match type based on subject and FULL course number (including suffix)
 * 
 * CRITICAL: BIOL 2251L != BIOL 2251
 * - Same base number but different suffix = FUZZY match, not EXACT
 */
function classifyMatch(requestedSubject, requestedNumber, foundSubject, foundNumber) {
  const reqSubj = (requestedSubject || '').toUpperCase().trim();
  const foundSubj = (foundSubject || '').toUpperCase().trim();

  const reqNum = parseCourseNumber(requestedNumber);
  const foundNum = parseCourseNumber(foundNumber);

  console.log(`  Comparing: ${reqSubj} ${reqNum.full} vs ${foundSubj} ${foundNum.full}`);
  console.log(`    Requested: base=${reqNum.base}, suffix="${reqNum.suffix}"`);
  console.log(`    Found: base=${foundNum.base}, suffix="${foundNum.suffix}"`);

  // Check subject match
  const subjectMatches = reqSubj === foundSubj;

  // Check number match
  const baseMatches = reqNum.base === foundNum.base;
  const suffixMatches = reqNum.suffix === foundNum.suffix;
  const fullNumberMatches = baseMatches && suffixMatches;

  let matchType = 'no_match';
  let similarity = 0;

  if (subjectMatches && fullNumberMatches) {
    // Perfect match: BIOL 2251L == BIOL 2251L
    matchType = 'exact';
    similarity = 1.0;
  } else if (subjectMatches && baseMatches && !suffixMatches) {
    // Same base but different suffix: BIOL 2251L vs BIOL 2251
    // This is a FUZZY match - the lab and lecture are related but not the same
    if (reqNum.suffix && !foundNum.suffix) {
      // Requested has suffix (e.g., 2251L), found doesn't (e.g., 2251)
      // This means we're looking for a lab but found the lecture
      matchType = 'fuzzy';
      similarity = 0.85; // High similarity but NOT exact
      console.log(`    -> Suffix mismatch: requested "${reqNum.suffix}" but found "${foundNum.suffix}"`);
    } else if (!reqNum.suffix && foundNum.suffix) {
      // Requested doesn't have suffix, found does
      matchType = 'fuzzy';
      similarity = 0.85;
      console.log(`    -> Suffix mismatch: requested no suffix but found "${foundNum.suffix}"`);
    } else {
      // Both have different suffixes
      matchType = 'fuzzy';
      similarity = 0.80;
      console.log(`    -> Different suffixes: "${reqNum.suffix}" vs "${foundNum.suffix}"`);
    }
  } else if (subjectMatches) {
    // Subject matches but numbers don't
    const numSimilarity = calculateSimilarity(reqNum.full, foundNum.full);
    similarity = numSimilarity * 0.9; // Slight penalty

    if (similarity >= 0.85) {
      matchType = 'strong_fuzzy';
    } else if (similarity >= 0.70) {
      matchType = 'fuzzy';
    }
  } else {
    // Different subjects - use full string comparison
    const fullReq = `${reqSubj} ${reqNum.full}`;
    const fullFound = `${foundSubj} ${foundNum.full}`;
    similarity = calculateSimilarity(fullReq, fullFound);

    if (similarity >= 0.90) {
      matchType = 'strong_fuzzy';
    } else if (similarity >= 0.70) {
      matchType = 'fuzzy';
    }
  }

  console.log(`    -> Result: ${matchType} (similarity: ${similarity.toFixed(2)})`);

  return { matchType, similarity };
}

/**
 * Check if institution name matches with abbreviation handling
 */
function checkInstitutionMatch(requested, found) {
  if (!requested || !found) return { matches: false, ratio: 0 };

  const normalize = (str) => str.toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const req = normalize(requested);
  const ref = normalize(found);

  if (req === ref) return { matches: true, ratio: 1.0 };

  const reqWords = req.split(' ').filter(w => w.length > 2);
  const refWords = ref.split(' ').filter(w => w.length > 2);

  const abbreviations = {
    'university': 'univ', 'college': 'coll', 'agricultural': 'ag',
    'technical': 'tech', 'technology': 'tech', 'institute': 'inst',
    'community': 'comm', 'state': 'st', 'north': 'n', 'south': 's',
    'east': 'e', 'west': 'w', 'district': 'dist', 'angeles': 'la',
    'los': 'la', 'san': 's'
  };

  let matchCount = 0;
  for (const w1 of reqWords) {
    for (const w2 of refWords) {
      if (w1 === w2) { matchCount++; break; }
      const abbr1 = abbreviations[w1];
      const abbr2 = abbreviations[w2];
      if ((abbr1 && abbr1 === w2) || (abbr2 && abbr2 === w1)) { matchCount++; break; }
      if (w1.length > 4 && w2.length > 4 && (w1.startsWith(w2) || w2.startsWith(w1))) { matchCount++; break; }
    }
  }

  const ratio = reqWords.length > 0 ? matchCount / reqWords.length : 0;
  return { matches: ratio >= 0.5, ratio };
}

// ============================================================================
// CATALOG NOT FOUND DETECTION
// ============================================================================

function detectCatalogNotFound(ragCandidates, requestedInstitution, requestedSubject, requestedNumber) {
  if (!ragCandidates || ragCandidates.length === 0) {
    return { notFound: true, reason: 'no_rag_results' };
  }

  const topScore = ragCandidates[0]?.score || 0;
  const thresholds = CONFIG.catalogNotFoundThresholds;

  if (topScore < thresholds.maxTopScore) {
    console.log(`Low RAG scores (top: ${topScore.toFixed(2)}) - checking institution match...`);

    let foundInstitutionMatch = false;
    let bestInstitutionRatio = 0;

    for (const candidate of ragCandidates.slice(0, 5)) {
      const instMatch = candidate.text.match(/([A-Z0-9 &\-]+)::[A-Z]{2,6}::\d/i);
      if (instMatch) {
        const foundInst = instMatch[1].trim();
        const { matches, ratio } = checkInstitutionMatch(requestedInstitution, foundInst);

        if (ratio > bestInstitutionRatio) {
          bestInstitutionRatio = ratio;
        }

        if (matches) {
          foundInstitutionMatch = true;
          break;
        }
      }
    }

    if (!foundInstitutionMatch && bestInstitutionRatio < thresholds.minInstitutionMatchRatio) {
      return {
        notFound: true,
        reason: 'institution_not_indexed',
        details: { topScore, bestInstitutionRatio, requestedInstitution }
      };
    }
  }

  // Note: We do NOT check for specific course here anymore
  // That's handled by the extraction logic

  return { notFound: false };
}

// ============================================================================
// COURSE DATA EXTRACTION
// ============================================================================

/**
 * Extract course data from a CSV chunk
 * 
 * IMPORTANT: This now properly handles suffixes
 * - If looking for 2251L, it will try to find 2251L first
 * - If 2251L not found, it returns null (not 2251)
 */
function extractCourseFromChunk(chunkText, requestedSubject, requestedNumber, requestedInstitution) {
  if (!chunkText || typeof chunkText !== 'string') return null;

  const reqSubj = (requestedSubject || '').toUpperCase().trim();
  const reqNum = parseCourseNumber(requestedNumber);

  if (!reqSubj || !reqNum.base) return null;

  // First, try to find EXACT course number (with suffix)
  let canonicalPattern;
  let canonicalMatch;

  if (reqNum.suffix) {
    // Looking for course WITH suffix (e.g., 2251L)
    canonicalPattern = new RegExp(
      `([A-Z0-9 &\\-]+)::${reqSubj}::${reqNum.base}${reqNum.suffix}\\b`,
      'i'
    );
    canonicalMatch = chunkText.match(canonicalPattern);

    if (canonicalMatch) {
      console.log(`  Found exact course with suffix: ${reqSubj} ${reqNum.full}`);
    }
  }

  // If no suffix requested OR suffix version not found, try base number
  if (!canonicalMatch) {
    canonicalPattern = new RegExp(
      `([A-Z0-9 &\\-]+)::${reqSubj}::${reqNum.base}([A-Za-z]?)\\b`,
      'i'
    );
    canonicalMatch = chunkText.match(canonicalPattern);
  }

  if (!canonicalMatch) {
    return null;
  }

  const foundInstitution = canonicalMatch[1].trim();
  const foundSuffix = canonicalMatch[2] || '';
  const foundFullNumber = reqNum.base + foundSuffix;

  // Validate institution
  if (requestedInstitution) {
    const { matches } = checkInstitutionMatch(requestedInstitution, foundInstitution);
    if (!matches) {
      console.log(`  Institution mismatch: requested "${requestedInstitution}", found "${foundInstitution}"`);
      return null;
    }
  }

  // Extract description from course section
  const keyPos = canonicalMatch.index;
  const afterKey = chunkText.slice(keyPos);
  const nextCourseMatch = afterKey.slice(50).match(/\n[A-Z0-9 &\-]+::[A-Z]{2,6}::\d/);
  const sectionEnd = nextCourseMatch ? 50 + nextCourseMatch.index : afterKey.length;
  const courseSection = afterKey.slice(0, sectionEnd);

  // Extract title and description
  const dataPattern = new RegExp(
    `${reqSubj}[,\\s]+${reqNum.base}${foundSuffix}?[,\\s]+([^,]+)[,\\s]+"([^"]{20,})"`,
    'i'
  );

  let title = '';
  let description = '';

  const dataMatch = courseSection.match(dataPattern);
  if (dataMatch) {
    title = dataMatch[1].trim();
    description = dataMatch[2].trim();
  } else {
    const descFallback = courseSection.match(/"([^"]{50,})"/);
    if (descFallback) description = descFallback[1].trim();

    const titlePattern = new RegExp(`${reqSubj}[,\\s]+${reqNum.base}[A-Za-z]?[,\\s]+([^,]{3,50})[,\\s]`, 'i');
    const titleMatch = courseSection.match(titlePattern);
    if (titleMatch) title = titleMatch[1].trim();
  }

  const asuMatches = extractAsuMatchesFromSection(courseSection);

  return {
    institution: foundInstitution,
    subject: reqSubj,
    number: foundFullNumber,           // The number we actually found
    numberBase: reqNum.base,
    suffix: foundSuffix,               // The suffix we actually found
    requestedSuffix: reqNum.suffix,    // The suffix that was requested
    title,
    description,
    asuMatches,
    // Flag if we found a different variant
    isVariant: reqNum.suffix !== foundSuffix
  };
}

function extractAsuMatchesFromSection(courseSection) {
  const matches = [];
  const seen = new Set();

  const asuPattern = /ARIZONASTATEUNIVERSITY::([A-Z]{2,6})::(\d{3}[A-Za-z]?)/gi;
  let m;

  while ((m = asuPattern.exec(courseSection)) !== null && matches.length < 3) {
    const subj = m[1].toUpperCase();
    const num = m[2].replace('.0', '');
    const key = `${subj}::${num}`;

    if (!seen.has(key)) {
      seen.add(key);

      const afterMatch = courseSection.slice(m.index);
      const detailPattern = new RegExp(
        `${subj}[,\\s]+${num}[^,]*[,\\s]+([^,]+)[,\\s]+"([^"]+)"`,
        'i'
      );
      const details = afterMatch.match(detailPattern);

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

async function callRagSearch(token, query) {
  const payload = {
    query: query,
    search_params: {
      db_type: "opensearch",
      collection: "0cc3f744a8c740b0b36afb154d07ae24",
      top_k: 12,
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

  let hits = [];
  if (Array.isArray(json.response)) {
    hits = json.response;
  } else if (json.response?.response && Array.isArray(json.response.response)) {
    hits = json.response.response;
  } else if (Array.isArray(json.hits)) {
    hits = json.hits;
  }

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

async function callLlmQuery(token, query, systemPromptWithContext) {
  const payload = {
    model_provider: "openai",
    model_name: "gpt5_2",
    model_params: {
      temperature: 0.0,
      max_tokens: 1500,
      system_prompt: systemPromptWithContext
    },
    query: query,
    enable_search: false,
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

async function fetchCourseData(courseData) {
  const startTime = Date.now();

  try {
    const storage = await chrome.storage.local.get({ createaiToken: '' });
    const token = storage.createaiToken;

    if (!token) {
      return { success: false, error: 'API Token missing. Please set it in extension options.' };
    }

    const institution = courseData.institution || '';
    const subject = (courseData.subject || '').toUpperCase().trim();
    const number = (courseData.number || '').toString().trim();
    const title = courseData.title || '';

    const reqNum = parseCourseNumber(number);

    const query = `${institution} ${subject} ${number} ${title}`.trim();
    console.log('='.repeat(60));
    console.log('Fetching course data for:', query);
    console.log(`Requested: ${subject} ${reqNum.full} (base: ${reqNum.base}, suffix: "${reqNum.suffix}")`);

    // ========================================
    // STEP 1: RAG Search
    // ========================================
    const ragCandidates = await callRagSearch(token, query);

    // ========================================
    // STEP 2: FAST CHECK - Is catalog indexed?
    // ========================================
    if (CONFIG.skipLlmWhenCatalogNotFound) {
      const catalogCheck = detectCatalogNotFound(ragCandidates, institution, subject, reqNum.base);

      if (catalogCheck.notFound) {
        console.log(`⚡ FAST PATH: Catalog not found (reason: ${catalogCheck.reason})`);

        return buildResponse({
          matchType: 'catalog_not_found',
          similarity: 0,
          description: 'Cannot find the course description',
          descriptionMissing: true,
          matches: [],
          elapsedMs: Date.now() - startTime,
          path: 'fast_catalog_not_found',
          reason: catalogCheck.reason
        });
      }
    }

    // ========================================
    // STEP 3: Try Deterministic Extraction
    // ========================================
    if (CONFIG.enableTimingLogs) console.time('Deterministic Extraction');

    let extractedCourse = null;
    let extractionSource = null;

    for (const candidate of ragCandidates) {
      const extracted = extractCourseFromChunk(
        candidate.text,
        subject,
        number,  // Pass FULL number including suffix
        institution
      );

      if (extracted && extracted.description && extracted.description.length >= CONFIG.minDescriptionLength) {
        extractedCourse = extracted;
        extractionSource = {
          id: candidate.id,
          score: candidate.score
        };
        break;
      }
    }

    if (CONFIG.enableTimingLogs) console.timeEnd('Deterministic Extraction');

    // ========================================
    // STEP 4: Classify Match (with proper suffix handling)
    // ========================================
    let matchType = 'no_match';
    let similarity = 0;
    let reflectedCourse = { subject: '', number: '', title: '' };
    let description = 'Cannot find the course description';
    let descriptionMissing = true;
    let matches = [];

    if (extractedCourse) {
      // Use the new classification that properly handles suffixes
      const classification = classifyMatch(
        subject,
        reqNum.full,           // FULL requested number (e.g., "2251L")
        extractedCourse.subject,
        extractedCourse.number // FULL found number (e.g., "2251")
      );

      matchType = classification.matchType;
      similarity = classification.similarity;

      reflectedCourse = {
        subject: extractedCourse.subject,
        number: extractedCourse.number,
        title: extractedCourse.title
      };

      matches = extractedCourse.asuMatches || [];

      // Only populate description for EXACT matches
      if (matchType === 'exact' && extractedCourse.description) {
        description = extractedCourse.description;
        descriptionMissing = false;
      }

      console.log(`Deterministic extraction result:`);
      console.log(`  Requested: ${subject} ${reqNum.full}`);
      console.log(`  Found: ${extractedCourse.subject} ${extractedCourse.number}`);
      console.log(`  Match type: ${matchType} (similarity: ${similarity.toFixed(2)})`);
      console.log(`  Is variant: ${extractedCourse.isVariant}`);
      console.log(`  Description length: ${extractedCourse.description?.length || 0}`);
      console.log(`  ASU matches: ${matches.length}`);
    }

    // ========================================
    // STEP 5: Decide if LLM is needed
    // ========================================
    // Only skip LLM for TRUE exact matches (same subject AND same full number)
    const canSkipLlm = CONFIG.skipLlmWhenExactMatch &&
      matchType === 'exact' &&
      !descriptionMissing &&
      extractionSource?.score >= CONFIG.minRagScoreForTrust;

    if (canSkipLlm) {
      console.log('✅ FAST PATH: Exact match found, skipping LLM');

      return buildResponse({
        matchType,
        similarity,
        reflectedCourse,
        description,
        descriptionMissing,
        matches,
        elapsedMs: Date.now() - startTime,
        path: 'fast_exact_match',
        extractionMethod: 'deterministic',
        ragScore: extractionSource.score
      });
    }

    // ========================================
    // STEP 6: Call LLM for fuzzy/no_match cases
    // ========================================
    console.log('⚠️ SLOW PATH: Calling LLM for validation/matching');
    console.log(`  Reason: matchType=${matchType}, descriptionMissing=${descriptionMissing}`);

    const ragContext = ragCandidates.slice(0, 3)
      .map(c => c.text.slice(0, 1500))
      .join('\n\n---NEXT CHUNK---\n\n');

    const systemPrompt = buildLlmSystemPrompt(ragContext, extractedCourse, subject, reqNum.full);

    try {
      const llmResponse = await callLlmQuery(token, query, systemPrompt);

      let responseText = llmResponse.response || '';
      responseText = responseText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      const parsed = JSON.parse(responseText);

      const llmSubject = parsed.subject || '';
      const llmNumber = parsed.number || '';
      const llmTitle = parsed.title || '';
      const llmDescription = parsed.input_course_description || '';
      const catalogStatus = parsed.catalog_status || '';

      if (catalogStatus === 'not_indexed' || catalogStatus === 'not_found') {
        matchType = 'catalog_not_found';
        similarity = 0;
      } else if (llmSubject && llmNumber) {
        // Classify using full numbers
        const llmClassification = classifyMatch(subject, reqNum.full, llmSubject, llmNumber);
        matchType = llmClassification.matchType;
        similarity = llmClassification.similarity;

        reflectedCourse = {
          subject: llmSubject,
          number: llmNumber,
          title: llmTitle
        };
      }

      // Handle description
      const llmDescLower = (llmDescription || '').toLowerCase();
      const llmHasValidDesc = llmDescription &&
        llmDescription.length >= 30 &&
        !llmDescLower.includes('cannot find');

      // For exact match, use description; for fuzzy, also show related description
      if (matchType === 'exact' || matchType === 'fuzzy' || matchType === 'strong_fuzzy') {
        if (llmHasValidDesc) {
          description = llmDescription;
          descriptionMissing = false;
        } else if (extractedCourse?.description) {
          description = extractedCourse.description;
          descriptionMissing = false;
        }
      }

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

      // Prefer LLM matches if available
      if (llmMatches.length > 0) {
        matches = llmMatches;
      } else if (extractedCourse?.asuMatches?.length > 0) {
        matches = extractedCourse.asuMatches;
      }

      return buildResponse({
        matchType,
        similarity,
        reflectedCourse,
        description,
        descriptionMissing: !description || description.toLowerCase().includes('cannot find'),
        matches,
        elapsedMs: Date.now() - startTime,
        path: 'llm_validated'
      });

    } catch (parseError) {
      console.error('LLM parse error:', parseError);

      return buildResponse({
        matchType: extractedCourse ? matchType : 'no_match',
        similarity,
        reflectedCourse,
        description: extractedCourse?.description || 'Cannot find the course description',
        descriptionMissing: !extractedCourse?.description,
        matches: extractedCourse?.asuMatches || [],
        elapsedMs: Date.now() - startTime,
        path: 'deterministic_after_llm_error'
      });
    }

  } catch (error) {
    console.error('Fetch error:', error);
    return { success: false, error: error.message };
  }
}

function buildLlmSystemPrompt(ragContext, extractedCourse, requestedSubject, requestedNumber) {
  let contextNote = '';
  if (extractedCourse) {
    contextNote = `
NOTE: Deterministic extraction found a RELATED course:
- Found: ${extractedCourse.subject} ${extractedCourse.number}
- Requested: ${requestedSubject} ${requestedNumber}
- This may be the lecture version of a lab course, or vice versa.
- If the exact course (${requestedSubject} ${requestedNumber}) is not in the data, return catalog_status: "found" but set subject/number to what was actually found.
`;
  }

  return `You are a course catalog validation assistant.

TASK: Analyze the RAG search results for: ${requestedSubject} ${requestedNumber}

IMPORTANT: Pay attention to course number SUFFIXES!
- "2251L" (with L) is a LAB course
- "2251" (without L) is a LECTURE course  
- These are DIFFERENT courses - do not confuse them!

RAG SEARCH RESULTS:
${ragContext}
${contextNote}

RULES:
1. Do NOT hallucinate courses or descriptions
2. If looking for "2251L" but only "2251" exists, report what was found (2251)
3. Extract the EXACT description from the data
4. Always return exactly 3 ASU matches (empty objects if not found)

Return ONLY this JSON:
{
  "catalog_status": "found" | "not_indexed",
  "subject": "",
  "number": "",
  "title": "",
  "input_course_description": "",
  "matches": {
    "match_1": { "subject": "", "number": "", "title": "", "description": "" },
    "match_2": { "subject": "", "number": "", "title": "", "description": "" },
    "match_3": { "subject": "", "number": "", "title": "", "description": "" }
  }
}`;
}

function buildResponse(params) {
  const {
    matchType,
    similarity,
    reflectedCourse = { subject: '', number: '', title: '' },
    description,
    descriptionMissing,
    matches = [],
    elapsedMs,
    path,
    extractionMethod,
    ragScore,
    reason
  } = params;

  const response = {
    success: true,
    match_type: matchType,
    similarity: similarity,
    reflected_course: reflectedCourse,
    description: description || 'Cannot find the course description',
    description_is_missing: descriptionMissing,
    matches: matches,
    _debug: {
      totalMs: elapsedMs,
      path: path,
      extractionMethod: extractionMethod,
      ragScore: ragScore,
      reason: reason
    }
  };

  console.log(`Result: ${matchType} (similarity: ${similarity?.toFixed(2) || 0})`);
  console.log(`Description: ${descriptionMissing ? 'MISSING' : description?.slice(0, 50) + '...'}`);
  console.log(`ASU Matches: ${matches.length}`);
  console.log(`Total time: ${elapsedMs}ms | Path: ${path}`);
  console.log('='.repeat(60));

  return response;
}

console.log('Triangulator extension (OPTIMIZED v3.2) loaded');
console.log('Config:', CONFIG);