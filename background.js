// background.js - ASU CreateAI API integration (OPTIMIZED v3.10)
// 
// Fixes in v3.10:
// 1. Check top 10 RAG candidates (instead of 5) when looking for institution
// 2. More lenient catalog detection - helps catch institutions deeper in results
// 3. Reduces false "catalog_not_found" when institution IS indexed but appears deeper
// 
// Previous fixes: 
// - Corrected catalog detection: found institution = no_match, not catalog_not_found
// - Filter ASU matches without valid descriptions
// - Comprehensive ASU match collection from all course variants

// ============================================================================
// ENVIRONMENT CONFIGURATION
// ============================================================================
const ENVIRONMENTS = {
  poc: {
    name: 'POC (Development)',
    searchUrl: 'https://api-main-poc.aiml.asu.edu/search',
    queryUrl: 'https://api-main-poc.aiml.asu.edu/query'
  },
  prod: {
    name: 'Production',
    searchUrl: 'https://api-main.aiml.asu.edu/search',  // Add production search URL here
    queryUrl: 'https://api-main.aiml.asu.edu/query'   // Add production query URL here
  }
};

const DEFAULT_ENVIRONMENT = 'poc';

// Dynamic API config - will be loaded from storage
let API_CONFIG = {
  searchUrl: ENVIRONMENTS[DEFAULT_ENVIRONMENT].searchUrl,
  queryUrl: ENVIRONMENTS[DEFAULT_ENVIRONMENT].queryUrl
};

// Load environment config from storage
async function loadApiConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ environment: DEFAULT_ENVIRONMENT }, (items) => {
      const env = items.environment;
      const config = ENVIRONMENTS[env] || ENVIRONMENTS[DEFAULT_ENVIRONMENT];
      API_CONFIG.searchUrl = config.searchUrl;
      API_CONFIG.queryUrl = config.queryUrl;
      log.info(`[ENV] Loaded environment: ${env}`);
      log.info(`[ENV] Search URL: ${API_CONFIG.searchUrl}`);
      log.info(`[ENV] Query URL: ${API_CONFIG.queryUrl}`);
      resolve(API_CONFIG);
    });
  });
}

// Initialize config on startup
loadApiConfig();

// Listen for storage changes to update config dynamically
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.environment) {
    const newEnv = changes.environment.newValue;
    const config = ENVIRONMENTS[newEnv] || ENVIRONMENTS[DEFAULT_ENVIRONMENT];
    API_CONFIG.searchUrl = config.searchUrl;
    API_CONFIG.queryUrl = config.queryUrl;
    log.info(`[ENV] Environment changed to: ${newEnv}`);
  }
});

// ============================================================================
// LOGGING CONFIGURATION
// ============================================================================
// LOG_LEVEL options:
//   "INFO"  - Only important messages (results, errors, fast path decisions)
//   "DEBUG" - Detailed debugging info (extraction details, match filtering)
//   "LOCAL" - Full verbose logging including raw chunks (for local development)
const LOG_LEVEL = "INFO";

const LOG_LEVELS = {
  INFO: 1,
  DEBUG: 2,
  LOCAL: 3
};

const log = {
  info: (...args) => {
    if (LOG_LEVELS[LOG_LEVEL] >= LOG_LEVELS.INFO) {
      console.log(...args);
    }
  },
  debug: (...args) => {
    if (LOG_LEVELS[LOG_LEVEL] >= LOG_LEVELS.DEBUG) {
      console.log(...args);
    }
  },
  local: (...args) => {
    if (LOG_LEVELS[LOG_LEVEL] >= LOG_LEVELS.LOCAL) {
      console.log(...args);
    }
  },
  time: (label) => {
    if (LOG_LEVELS[LOG_LEVEL] >= LOG_LEVELS.DEBUG) {
      console.time(label);
    }
  },
  timeEnd: (label) => {
    if (LOG_LEVELS[LOG_LEVEL] >= LOG_LEVELS.DEBUG) {
      console.timeEnd(label);
    }
  }
};

const CONFIG = {
  skipLlmWhenExactMatch: true,
  skipLlmWhenCatalogNotFound: true,
  minRagScoreForTrust: 8.0,
  minDescriptionLength: 50,

  catalogNotFoundThresholds: {
    maxTopScore: 12.0,
    minInstitutionMatchRatio: 0.4
  },

  // LLM optimization settings
  llmMaxContextChars: 2500,    // Reduced from 4500 to speed up
  llmMaxTokens: 800,           // Reduced from 1500
  llmModel: "nova-lite",       // Can change to faster model if available

  // Description validation
  invalidDescriptionText: 'cannot find' // Magic string for invalid descriptions
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
 */
function classifyMatch(requestedSubject, requestedNumber, foundSubject, foundNumber) {
  const reqSubj = (requestedSubject || '').toUpperCase().trim();
  const foundSubj = (foundSubject || '').toUpperCase().trim();

  const reqNum = parseCourseNumber(requestedNumber);
  const foundNum = parseCourseNumber(foundNumber);

  // Check subject match
  const subjectMatches = reqSubj === foundSubj;

  // Check number match
  const baseMatches = reqNum.base === foundNum.base;
  const suffixMatches = reqNum.suffix === foundNum.suffix;
  const fullNumberMatches = baseMatches && suffixMatches;

  let matchType = 'no_match';
  let similarity = 0;

  if (subjectMatches && fullNumberMatches) {
    matchType = 'exact';
    similarity = 1.0;
  } else if (subjectMatches && baseMatches && !suffixMatches) {
    if (reqNum.suffix && !foundNum.suffix) {
      matchType = 'fuzzy';
      similarity = 0.85;
    } else if (!reqNum.suffix && foundNum.suffix) {
      matchType = 'fuzzy';
      similarity = 0.85;
    } else {
      matchType = 'fuzzy';
      similarity = 0.80;
    }
  } else if (subjectMatches) {
    const numSimilarity = calculateSimilarity(reqNum.full, foundNum.full);
    similarity = numSimilarity * 0.9;

    if (similarity >= 0.85) {
      matchType = 'strong_fuzzy';
    } else if (similarity >= 0.70) {
      matchType = 'fuzzy';
    }
  } else {
    // Different subjects - this should NOT be exact match
    const fullReq = `${reqSubj} ${reqNum.full}`;
    const fullFound = `${foundSubj} ${foundNum.full}`;
    similarity = calculateSimilarity(fullReq, fullFound);

    if (similarity >= 0.90) {
      matchType = 'strong_fuzzy';
    } else if (similarity >= 0.70) {
      matchType = 'fuzzy';
    }
    // If subjects don't match, similarity is at most ~0.7, never exact
  }

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
    log.debug(`Low RAG scores (top: ${topScore.toFixed(2)}) - checking institution match...`);

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

  return { notFound: false };
}

// ============================================================================
// COURSE DATA EXTRACTION
// ============================================================================

function extractCourseFromChunk(chunkText, requestedSubject, requestedNumber, requestedInstitution) {
  if (!chunkText || typeof chunkText !== 'string') return null;

  const reqSubj = (requestedSubject || '').toUpperCase().trim();
  const reqNum = parseCourseNumber(requestedNumber);

  if (!reqSubj || !reqNum.base) return null;

  let canonicalPattern;
  let canonicalMatch;

  if (reqNum.suffix) {
    canonicalPattern = new RegExp(
      `([A-Z0-9 &\\-]+)::${reqSubj}::${reqNum.base}${reqNum.suffix}\\b`,
      'i'
    );
    canonicalMatch = chunkText.match(canonicalPattern);
  }

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

  if (requestedInstitution) {
    const { matches } = checkInstitutionMatch(requestedInstitution, foundInstitution);
    if (!matches) {
      return null;
    }
  }

  const keyPos = canonicalMatch.index;
  const afterKey = chunkText.slice(keyPos);
  const nextCourseMatch = afterKey.slice(50).match(/\n[A-Z0-9 &\-]+::[A-Z]{2,6}::\d/);
  const sectionEnd = nextCourseMatch ? 50 + nextCourseMatch.index : afterKey.length;
  const courseSection = afterKey.slice(0, sectionEnd);

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
    number: foundFullNumber,
    numberBase: reqNum.base,
    suffix: foundSuffix,
    requestedSuffix: reqNum.suffix,
    title,
    description,
    asuMatches,
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
      
      // CSV format based on column structure:
      // match_canonical_key,match_CourseSubject,match_CourseNumber,match_CourseLongTitle,match_CourseDescription,match_CourseCreditUnits,match_CourseCreditMinimumValue,match_CourseCreditMaximumValue,match_Softmaxvalue
      // Example: ARIZONASTATEUNIVERSITY::BIO::201,BIO,201.0,Human Anatomy/Physiology I,"Description...",Semester,4.0,4.0,0.708...
      const csvPattern = new RegExp(
        `ARIZONASTATEUNIVERSITY::${subj}::${num},${subj},${num}(?:\\.0)?,([^,]+),"([^"]+)",([^,]+),([\\d.]+),([\\d.]+)`,
        'i'
      );
      const csvDetails = afterMatch.match(csvPattern);
      
      // Fallback: pattern with quoted description but no credits (description may continue to end)
      const simplePattern = new RegExp(
        `${subj}[,\\s]+${num}[^,]*[,\\s]+([^,]+)[,\\s]+"([^"]+)"`,
        'i'
      );
      const simpleDetails = afterMatch.match(simplePattern);
      
      // Last resort: pattern for truncated data (description may be cut off without closing quote)
      const truncatedPattern = new RegExp(
        `ARIZONASTATEUNIVERSITY::${subj}::${num},${subj},${num}(?:\\.0)?,([^,]+),"([^"]+)`,
        'i'
      );
      const truncatedDetails = afterMatch.match(truncatedPattern);

      let title = '';
      let description = '';
      let hours = null;

      if (csvDetails) {
        title = csvDetails[1].trim();
        description = csvDetails[2].trim();
        const creditMin = parseFloat(csvDetails[4]);
        const creditMax = parseFloat(csvDetails[5]);
        
        log.debug(`  📊 Credit hours for ${subj} ${num}: min=${creditMin}, max=${creditMax}`);
        
        // Format credit hours: single value if same, range if different
        if (!isNaN(creditMin) && !isNaN(creditMax) && creditMin > 0) {
          if (creditMin === creditMax) {
            hours = creditMin;
            log.debug(`    → Single value: ${hours} credit hour(s)`);
          } else {
            hours = `${creditMin} - ${creditMax}`;
            log.debug(`    → Range: ${hours} credit hours`);
          }
        } else {
          log.debug(`    → Invalid credit values, skipping`);
        }
      } else if (simpleDetails) {
        title = simpleDetails[1].trim();
        description = simpleDetails[2].trim();
        log.debug(`  📊 No CSV pattern match for ${subj} ${num}, using simple pattern (no credit hours)`);
      } else if (truncatedDetails) {
        title = truncatedDetails[1].trim();
        description = truncatedDetails[2].trim();
        log.debug(`  📊 Truncated data for ${subj} ${num}, extracted partial description (no credit hours)`);
      } else {
        log.debug(`  📊 No details found for ${subj} ${num}`);
      }

      matches.push({
        subject: subj,
        number: num,
        title: title,
        description: description,
        hours: hours
      });
    }
  }

  return matches;
}

/**
 * Filter ASU matches to only include those with valid descriptions
 * If a match has missing/invalid data, search across all chunks for complete data
 */
function filterValidAsuMatches(matches, ragCandidates = null) {
  if (!matches || matches.length === 0) return [];

  const filtered = matches.map((match, idx) => {
    let finalMatch = match;
    let hasValidDescription = isValidAsuDescription(match.description);

    // If description is invalid/missing OR credit hours are missing, try to find complete data in other chunks
    const needsCompleteData = !hasValidDescription || (hasValidDescription && match.hours === null);
    
    if (needsCompleteData && ragCandidates) {
      log.debug(`  🔍 Searching other chunks for complete data: ${match.subject} ${match.number} (reason: ${!hasValidDescription ? 'invalid description' : 'missing credit hours'})`);
      const completeData = findCompleteAsuMatchData(ragCandidates, match.subject, match.number);
      if (completeData && isValidAsuDescription(completeData.description)) {
        log.debug(`  ✅ Found complete data in another chunk for ${match.subject} ${match.number} (hours: ${completeData.hours})`);
        finalMatch = completeData;
        hasValidDescription = true;
      }
    }

    if (!hasValidDescription) {
      log.debug(`  ❌ Filtered out match ${idx + 1}: ${finalMatch.subject} ${finalMatch.number} (desc length: ${finalMatch.description?.length || 0})`);
      return null;
    } else {
      log.debug(`  ✅ Keeping match ${idx + 1}: ${finalMatch.subject} ${finalMatch.number} (desc length: ${finalMatch.description.length}, hours: ${finalMatch.hours})`);
      return finalMatch;
    }
  }).filter(m => m !== null);

  return filtered;
}

/**
 * Validate if an ASU course description is valid and meaningful
 * @param {string} description - The course description to validate
 * @returns {boolean} - True if description is valid (>= 30 chars and not "cannot find")
 */
function isValidAsuDescription(description) {
  if (!description) {
    return false;
  }

  const lower = description.toLowerCase();
  return description.length >= 30 && !lower.includes(CONFIG.invalidDescriptionText);
}

/**
 * Search all chunks to find complete data for a specific ASU course
 * This helps when a course appears truncated in one chunk but complete in another
 */
function findCompleteAsuMatchData(ragCandidates, subj, num) {
  const csvPattern = new RegExp(
    `ARIZONASTATEUNIVERSITY::${subj}::${num},${subj},${num}(?:\\.0)?,([^,]+),"([^"]+)",([^,]+),([\\d.]+),([\\d.]+)`,
    'i'
  );
  
  for (const candidate of ragCandidates) {
    const match = candidate.text.match(csvPattern);
    if (match) {
      const creditMin = parseFloat(match[4]);
      const creditMax = parseFloat(match[5]);
      let hours = null;
      
      if (!isNaN(creditMin) && !isNaN(creditMax) && creditMin > 0) {
        hours = creditMin === creditMax ? creditMin : `${creditMin} - ${creditMax}`;
      }
      
      return {
        subject: subj,
        number: num,
        title: match[1].trim(),
        description: match[2].trim(),
        hours: hours
      };
    }
  }
  return null;
}

/**
 * Search across multiple RAG candidates for related course variants
 * and collect ALL unique ASU matches
 */
function collectAllAsuMatches(ragCandidates, institution, subject, numberBase) {
  const allMatches = [];
  const seen = new Set();

  // Search through all candidates for variants of this course (with/without suffix)
  for (const candidate of ragCandidates.slice(0, 5)) { // Check top 5 candidates
    const text = candidate.text;

    // Look for any course with same subject and number base
    const variantPattern = new RegExp(
      `${institution.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}::(${subject})::${numberBase}([A-Za-z]?)`,
      'gi'
    );

    let match;
    while ((match = variantPattern.exec(text)) !== null) {
      const foundSubj = match[1].toUpperCase();
      const foundSuffix = match[2] || '';
      const fullNumber = numberBase + foundSuffix;
      const key = `${foundSubj}::${fullNumber}`;

      // Extract ASU matches from this section
      const sectionStart = match.index;
      const afterMatch = text.slice(sectionStart);
      const nextCourseIdx = afterMatch.slice(100).search(/\n[A-Z0-9 &\-]+::[A-Z]{2,6}::\d/);
      const sectionEnd = nextCourseIdx > 0 ? 100 + nextCourseIdx : Math.min(afterMatch.length, 2000);
      const section = afterMatch.slice(0, sectionEnd);

      const asuMatches = extractAsuMatchesFromSection(section);
      for (const asuMatch of asuMatches) {
        const asuKey = `${asuMatch.subject}::${asuMatch.number}`;

        // CRITICAL: Only include matches that have valid descriptions
        // This prevents showing "3 of 3" when only 1 has a description
        const hasValidDescription = isValidAsuDescription(asuMatch.description);

        if (!seen.has(asuKey)) {
          if (hasValidDescription) {
            log.debug(`  ✅ CollectAll: Keeping ${asuMatch.subject} ${asuMatch.number} (desc: ${asuMatch.description.length} chars)`);
            seen.add(asuKey);
            allMatches.push(asuMatch);
            if (allMatches.length >= 10) return allMatches; // Cap at 10 matches
          } else {
            log.debug(`  ❌ CollectAll: Filtered ${asuMatch.subject} ${asuMatch.number} (desc: ${asuMatch.description?.length || 0} chars)`);
          }
        }
      }
    }
  }

  return allMatches;
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
      top_k: 1,
      output_fields: ["content", "source_name", "chunk_number", "page_number"],
      retrieval_type: "chunk"
    }
  };

  log.time('RAG /search');

  const response = await fetch(API_CONFIG.searchUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  log.timeEnd('RAG /search');

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

  log.debug(`RAG returned ${candidates.length} results, top scores:`,
    candidates.slice(0, 3).map(c => c.score.toFixed(2)));

  // Debug: Log the raw chunks from /search endpoint (LOCAL level only)
  log.local('='.repeat(60));
  log.local('🔍 RAG /search CHUNKS DEBUG:');
  candidates.forEach((chunk, idx) => {
    log.local(`\n--- Chunk ${idx + 1} (score: ${chunk.score.toFixed(4)}) ---`);
    log.local(`ID: ${chunk.id}`);
    log.local(`Text:\n${chunk.text}`);
  });
  log.local('='.repeat(60));

  return candidates;
}

async function callLlmQuery(token, query, systemPrompt) {
  const payload = {
    model_provider: "aws",
    model_name: CONFIG.llmModel,
    model_params: {
      temperature: 0.0,
      max_tokens: CONFIG.llmMaxTokens,
      system_prompt: systemPrompt
    },
    query: query,
    enable_search: false,
    response_format: { type: "json" }
  };

  log.time('LLM /query');

  const response = await fetch(API_CONFIG.queryUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  log.timeEnd('LLM /query');

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
    log.info('='.repeat(60));
    log.info('Fetching course data for:', query);
    log.debug(`Requested: ${subject} ${reqNum.full} (base: ${reqNum.base}, suffix: "${reqNum.suffix}")`);

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
        log.info(`⚡ FAST PATH: Catalog not found (reason: ${catalogCheck.reason})`);

        return buildResponse({
          matchType: 'catalog_not_found',
          similarity: 0,
          description: 'Catalog not indexed - institution not found in database',
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
    log.time('Deterministic Extraction');

    let extractedCourse = null;
    let extractionSource = null;
    let allExtractedVariants = []; // Collect ALL matching course variants

    for (const candidate of ragCandidates) {
      const extracted = extractCourseFromChunk(
        candidate.text,
        subject,
        number,
        institution
      );

      if (extracted && extracted.description && extracted.description.length >= CONFIG.minDescriptionLength) {
        // Keep the first valid extraction as the primary match
        if (!extractedCourse) {
          extractedCourse = extracted;
          extractionSource = {
            id: candidate.id,
            score: candidate.score
          };
        }

        // But continue collecting variants from other chunks
        allExtractedVariants.push(extracted);
      }
    }

    log.timeEnd('Deterministic Extraction');

    // ========================================
    // STEP 3.5: Secondary catalog check if extraction failed
    // ========================================
    // If we couldn't extract ANY valid course, check if it's because
    // the catalog isn't indexed at all (not just this specific course missing)
    if (!extractedCourse) {
      log.debug('No valid course extracted - checking if catalog is indexed...');

      // Check if we can find ANY course from this institution in the RAG results
      // Check top 10 candidates (expanded from 5) to handle cases where institution
      // appears deeper in results
      let foundAnyInstitutionMatch = false;
      let checkedCandidates = 0;

      for (const candidate of ragCandidates.slice(0, 10)) {
        checkedCandidates++;
        const instMatch = candidate.text.match(/([A-Z0-9 &\-]+)::[A-Z]{2,6}::\d/i);
        if (instMatch) {
          const foundInst = instMatch[1].trim();
          const { matches } = checkInstitutionMatch(institution, foundInst);
          if (matches) {
            foundAnyInstitutionMatch = true;
            log.debug(`  Found institution match: ${foundInst} (in candidate ${checkedCandidates})`);
            break;
          }
        }
      }

      // CRITICAL LOGIC:
      // If we found the institution in RAG results (even deep in the list),
      // the catalog IS indexed. Missing course = no_match, not catalog_not_found
      if (!foundAnyInstitutionMatch) {
        log.info(`⚡ FAST PATH: Catalog not found (no institution matches in top ${checkedCandidates} results)`);

        return buildResponse({
          matchType: 'catalog_not_found',
          similarity: 0,
          description: 'Catalog not indexed - institution not found in database',
          descriptionMissing: true,
          matches: [],
          elapsedMs: Date.now() - startTime,
          path: 'fast_catalog_not_found_after_extraction',
          reason: 'no_institution_found'
        });
      }

      // If we found the institution but couldn't extract the course, continue to description check
      // This will return "no_match" for this specific course
      log.debug(`  Institution IS indexed, but this specific course description is missing`);
    }

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
      const classification = classifyMatch(
        subject,
        reqNum.full,
        extractedCourse.subject,
        extractedCourse.number
      );

      matchType = classification.matchType;
      similarity = classification.similarity;

      reflectedCourse = {
        subject: extractedCourse.subject,
        number: extractedCourse.number,
        title: extractedCourse.title
      };

      // For exact matches, collect ASU matches from ALL related course variants
      if (matchType === 'exact') {
        const comprehensiveMatches = collectAllAsuMatches(
          ragCandidates,
          institution,
          subject,
          reqNum.base
        );
        // Filter is already applied inside collectAllAsuMatches
        const fallbackMatches = filterValidAsuMatches(extractedCourse.asuMatches || [], ragCandidates);
        matches = comprehensiveMatches.length > 0 ? comprehensiveMatches : fallbackMatches;

        log.debug(`ASU match collection: comprehensive=${comprehensiveMatches.length}, fallback=${fallbackMatches.length}, final=${matches.length}`);
      } else {
        // For fuzzy/no_match, filter the single-course extraction results
        const unfiltered = extractedCourse.asuMatches || [];
        matches = filterValidAsuMatches(unfiltered, ragCandidates);
        log.debug(`ASU match filtering: unfiltered=${unfiltered.length}, filtered=${matches.length}`);
      }

      if (matchType === 'exact' && extractedCourse.description) {
        description = extractedCourse.description;
        descriptionMissing = false;
      }

      log.debug(`Deterministic extraction result:`);
      log.debug(`  Requested: ${subject} ${reqNum.full}`);
      log.debug(`  Found: ${extractedCourse.subject} ${extractedCourse.number}`);
      log.debug(`  Match type: ${matchType} (similarity: ${similarity.toFixed(2)})`);
      log.debug(`  Description length: ${extractedCourse.description?.length || 0}`);
      log.debug(`  ASU matches: ${matches.length}`);
    }

    // ========================================
    // STEP 5: Decide if LLM is needed
    // ========================================
    const canSkipLlm = CONFIG.skipLlmWhenExactMatch &&
      matchType === 'exact' &&
      !descriptionMissing &&
      extractionSource?.score >= CONFIG.minRagScoreForTrust;

    if (canSkipLlm) {
      log.info('✅ FAST PATH: Exact match found, skipping LLM');

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
    // CRITICAL FIX: If description is missing, return no_match immediately
    // Course equivalency cannot be validated without a description to compare
    // ========================================
    if (descriptionMissing || !description || description === 'Cannot find the course description') {
      log.info('⚡ FAST PATH: Description missing - returning no_match without LLM call');
      log.debug(`  Attempted match type was: ${matchType}`);

      return buildResponse({
        matchType: 'no_match',
        similarity: 0,
        reflectedCourse: { subject: '', number: '', title: '' },
        description: 'Course description not found in indexed catalog',
        descriptionMissing: true,
        matches: [],
        elapsedMs: Date.now() - startTime,
        path: 'fast_no_description'
      });
    }

    // ========================================
    // STEP 6: Call LLM for fuzzy/no_match cases
    // ========================================
    log.info('⚠️ SLOW PATH: Calling LLM for validation/matching');
    log.debug(`  Reason: matchType=${matchType}, descriptionMissing=${descriptionMissing}`);

    // Build COMPACT context for faster LLM processing
    const ragContext = ragCandidates.slice(0, 2)
      .map(c => c.text.slice(0, CONFIG.llmMaxContextChars / 2))
      .join('\n---\n');

    const systemPrompt = buildLlmSystemPrompt(ragContext, extractedCourse, subject, reqNum.full, institution);

    try {
      const llmResponse = await callLlmQuery(token, query, systemPrompt);

      let responseText = llmResponse.response || '';
      responseText = responseText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      const parsed = JSON.parse(responseText);

      const llmSubject = (parsed.subject || '').toUpperCase().trim();
      const llmNumber = (parsed.number || '').toString().trim();
      const llmTitle = parsed.title || '';
      const llmDescription = parsed.input_course_description || '';
      const catalogStatus = parsed.catalog_status || '';

      // ========================================
      // CRITICAL FIX: Validate LLM response against request
      // ========================================
      // The LLM sometimes returns a DIFFERENT course than requested
      // We must validate that the returned course matches what was asked

      const llmClassification = classifyMatch(subject, reqNum.full, llmSubject, llmNumber);

      log.debug(`LLM returned: ${llmSubject} ${llmNumber}`);
      log.debug(`LLM classification: ${llmClassification.matchType} (similarity: ${llmClassification.similarity.toFixed(2)})`);

      if (catalogStatus === 'not_indexed' || catalogStatus === 'not_found') {
        matchType = 'catalog_not_found';
        similarity = 0;
        reflectedCourse = { subject: '', number: '', title: '' };
      } else if (llmSubject && llmNumber) {
        // USE THE CLASSIFICATION - don't just trust LLM saying it's "exact"
        matchType = llmClassification.matchType;
        similarity = llmClassification.similarity;

        reflectedCourse = {
          subject: llmSubject,
          number: llmNumber,
          title: llmTitle
        };
      } else {
        // LLM didn't return subject/number - fallback to deterministic
        if (extractedCourse) {
          matchType = classifyMatch(subject, reqNum.full, extractedCourse.subject, extractedCourse.number).matchType;
          reflectedCourse = {
            subject: extractedCourse.subject,
            number: extractedCourse.number,
            title: extractedCourse.title
          };
        }
      }

      // Handle description
      const llmDescLower = (llmDescription || '').toLowerCase();
      const llmHasValidDesc = llmDescription &&
        llmDescription.length >= 30 &&
        !llmDescLower.includes(CONFIG.invalidDescriptionText);

      // Only use description if it's an exact or fuzzy match
      if (matchType === 'exact' && llmHasValidDesc) {
        description = llmDescription;
        descriptionMissing = false;
      } else if ((matchType === 'fuzzy' || matchType === 'strong_fuzzy')) {
        // For fuzzy matches, show the related course description
        // But mark descriptionMissing based on whether description actually exists
        if (llmHasValidDesc) {
          description = llmDescription;
          descriptionMissing = false; // Description exists, just for a related course
        } else if (extractedCourse?.description) {
          description = extractedCourse.description;
          descriptionMissing = false; // Description exists, just for a related course
        } else {
          descriptionMissing = true; // Genuinely no description available
        }
      } else {
        descriptionMissing = true; // No match or no description
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

      if (llmMatches.length > 0) {
        matches = filterValidAsuMatches(llmMatches, ragCandidates);
      } else if (extractedCourse?.asuMatches?.length > 0) {
        matches = filterValidAsuMatches(extractedCourse.asuMatches, ragCandidates);
      }

      return buildResponse({
        matchType,
        similarity,
        reflectedCourse,
        description,
        descriptionMissing,
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

function buildLlmSystemPrompt(ragContext, extractedCourse, requestedSubject, requestedNumber, requestedInstitution) {
  // OPTIMIZED: Shorter, more focused prompt for faster processing
  return `Course catalog assistant. Find: ${requestedSubject} ${requestedNumber} at ${requestedInstitution}

DATA:
${ragContext}

RULES:
1. Find EXACT course ${requestedSubject} ${requestedNumber} - NOT a different course
2. "132" and "132L" are DIFFERENT courses
3. Return what you FOUND, not what was requested
4. If course not in data, set subject/number to empty

JSON only:
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

  // Clear distinction in logging
  if (matchType === 'catalog_not_found') {
    log.info(`Result: ⚠️  CATALOG NOT INDEXED - Institution's catalog is not in the database`);
  } else if (matchType === 'no_match') {
    log.info(`Result: ❌ NO MATCH - Course exists in catalog but description not found`);
  } else {
    log.info(`Result: ${matchType} (similarity: ${similarity?.toFixed(2) || 0})`);
  }

  log.info(`Description: ${descriptionMissing ? 'MISSING' : description?.slice(0, 50) + '...'}`);
  log.info(`ASU Matches: ${matches.length}`);
  log.info(`Total time: ${elapsedMs}ms | Path: ${path}`);
  log.info('='.repeat(60));

  return response;
}

log.info('Triangulator extension (OPTIMIZED v3.10) loaded');
log.info(`Log level: ${LOG_LEVEL}`);
log.debug('Config:', CONFIG);