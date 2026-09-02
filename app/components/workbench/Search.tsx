import { useState, useMemo, useCallback, useEffect } from 'react';
import { workbenchStore } from '~/lib/stores/workbench';
import { debounce } from '~/utils/debounce';

interface DisplayMatch {
  path: string;
  lineNumber: number;
  previewText: string;
  matchCharStart: number;
  matchCharEnd: number;
}

const EXCLUDED_PATH_SEGMENTS = ['node_modules', '.git', 'dist'];

function isExcludedPath(path: string): boolean {
  return (
    EXCLUDED_PATH_SEGMENTS.some((segment) => path.includes(`/${segment}/`)) ||
    path.endsWith('package-lock.json') ||
    path.endsWith('.lock')
  );
}

function performTextSearch(query: string, resultLimit: number, onProgress: (results: DisplayMatch[]) => void): void {
  const files = workbenchStore.files.get();
  const needle = query.toLowerCase();
  const displayMatches: DisplayMatch[] = [];

  for (const [path, dirent] of Object.entries(files)) {
    if (!dirent || dirent.type !== 'file' || dirent.isBinary || isExcludedPath(path)) {
      continue;
    }

    const lines = dirent.content.split('\n');

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const lowerLine = line.toLowerCase();
      let fromIndex = 0;

      while (displayMatches.length < resultLimit) {
        const matchStart = lowerLine.indexOf(needle, fromIndex);

        if (matchStart === -1) {
          break;
        }

        displayMatches.push({
          path,
          lineNumber: lineIndex + 1,
          previewText: line,
          matchCharStart: matchStart,
          matchCharEnd: matchStart + needle.length,
        });

        fromIndex = matchStart + needle.length;
      }

      if (displayMatches.length >= resultLimit) {
        break;
      }
    }

    if (displayMatches.length >= resultLimit) {
      break;
    }
  }

  if (displayMatches.length > 0) {
    onProgress(displayMatches);
  }
}

function groupResultsByFile(results: DisplayMatch[]): Record<string, DisplayMatch[]> {
  return results.reduce(
    (acc, result) => {
      if (!acc[result.path]) {
        acc[result.path] = [];
      }

      acc[result.path].push(result);

      return acc;
    },
    {} as Record<string, DisplayMatch[]>,
  );
}

export function Search() {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<DisplayMatch[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const [hasSearched, setHasSearched] = useState(false);

  const groupedResults = useMemo(() => groupResultsByFile(searchResults), [searchResults]);

  useEffect(() => {
    if (searchResults.length > 0) {
      const allExpanded: Record<string, boolean> = {};
      Object.keys(groupedResults).forEach((file) => {
        allExpanded[file] = true;
      });
      setExpandedFiles(allExpanded);
    }
  }, [groupedResults, searchResults]);

  const handleSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      setExpandedFiles({});
      setHasSearched(false);

      return;
    }

    setIsSearching(true);
    setSearchResults([]);
    setExpandedFiles({});
    setHasSearched(true);

    const minLoaderTime = 300; // ms
    const start = Date.now();

    try {
      const progressHandler = (batchResults: DisplayMatch[]) => {
        setSearchResults((prevResults) => [...prevResults, ...batchResults]);
      };

      performTextSearch(query, 500, progressHandler);
    } catch (error) {
      console.error('Failed to initiate search:', error);
    } finally {
      const elapsed = Date.now() - start;

      if (elapsed < minLoaderTime) {
        setTimeout(() => setIsSearching(false), minLoaderTime - elapsed);
      } else {
        setIsSearching(false);
      }
    }
  }, []);

  const debouncedSearch = useCallback(debounce(handleSearch, 300), [handleSearch]);

  useEffect(() => {
    debouncedSearch(searchQuery);
  }, [searchQuery, debouncedSearch]);

  const handleResultClick = (filePath: string, line?: number) => {
    workbenchStore.setSelectedFile(filePath);

    /*
     * Adjust line number to be 0-based if it's defined
     * The search results use 1-based line numbers, but CodeMirrorEditor expects 0-based
     */
    const adjustedLine = typeof line === 'number' ? Math.max(0, line - 1) : undefined;

    workbenchStore.setCurrentDocumentScrollPosition({ line: adjustedLine, column: 0 });
  };

  return (
    <div className="flex flex-col h-full bg-bolt-elements-background-depth-2">
      {/* Search Bar */}
      <div className="flex items-center py-3 px-3">
        <div className="relative flex-1">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search"
            className="w-full px-2 py-1 rounded-md bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary placeholder-bolt-elements-textTertiary focus:outline-none transition-all"
          />
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-auto py-2">
        {isSearching && (
          <div className="flex items-center justify-center h-32 text-bolt-elements-textTertiary">
            <div className="i-ph:circle-notch animate-spin mr-2" /> Searching...
          </div>
        )}
        {!isSearching && hasSearched && searchResults.length === 0 && searchQuery.trim() !== '' && (
          <div className="flex items-center justify-center h-32 text-gray-500">No results found.</div>
        )}
        {!isSearching &&
          Object.keys(groupedResults).map((file) => (
            <div key={file} className="mb-2">
              <button
                className="flex gap-2 items-center w-full text-left py-1 px-2 text-bolt-elements-textSecondary bg-transparent hover:bg-bolt-elements-background-depth-3 group"
                onClick={() => setExpandedFiles((prev) => ({ ...prev, [file]: !prev[file] }))}
              >
                <span
                  className=" i-ph:caret-down-thin w-3 h-3 text-bolt-elements-textSecondary transition-transform"
                  style={{ transform: expandedFiles[file] ? 'rotate(180deg)' : undefined }}
                />
                <span className="font-normal text-sm">{file.split('/').pop()}</span>
                <span className="h-5.5 w-5.5 flex items-center justify-center text-xs ml-auto bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent rounded-full">
                  {groupedResults[file].length}
                </span>
              </button>
              {expandedFiles[file] && (
                <div className="">
                  {groupedResults[file].map((match, idx) => {
                    const contextChars = 7;
                    const isStart = match.matchCharStart <= contextChars;
                    const previewStart = isStart ? 0 : match.matchCharStart - contextChars;
                    const previewText = match.previewText.slice(previewStart);
                    const matchStart = isStart ? match.matchCharStart : contextChars;
                    const matchEnd = isStart
                      ? match.matchCharEnd
                      : contextChars + (match.matchCharEnd - match.matchCharStart);

                    return (
                      <div
                        key={idx}
                        className="hover:bg-bolt-elements-background-depth-3 cursor-pointer transition-colors pl-6 py-1"
                        onClick={() => handleResultClick(match.path, match.lineNumber)}
                      >
                        <pre className="font-mono text-xs text-bolt-elements-textTertiary truncate">
                          {!isStart && <span>...</span>}
                          {previewText.slice(0, matchStart)}
                          <span className="bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent rounded px-1">
                            {previewText.slice(matchStart, matchEnd)}
                          </span>
                          {previewText.slice(matchEnd)}
                        </pre>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
