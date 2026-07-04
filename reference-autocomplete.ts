import type {
	AutocompleteItem,
	AutocompleteProvider,
} from "@earendil-works/pi-tui";

export interface ReferenceEntry {
	path: string;
	description: string;
	aliases?: string[];
}

const MAX_REFERENCE_SUGGESTIONS = 20;
const REFERENCE_TRIGGER_PATTERN = /(?:^|[ \t])@([a-zA-Z0-9_-]*)$/;

export function extractReferenceToken(textBeforeCursor: string): string | undefined {
	const match = textBeforeCursor.match(REFERENCE_TRIGGER_PATTERN);
	if (!match) {
		return undefined;
	}
	return match[1] ?? "";
}

function getReferenceMatchRank(key: string, entry: ReferenceEntry, query: string): number {
	if (query.length === 0) {
		return 0;
	}

	const lowerKey = key.toLowerCase();
	if (lowerKey.startsWith(query)) {
		return 0;
	}

	const aliases = entry.aliases ?? [];
	for (const alias of aliases) {
		if (alias.toLowerCase().startsWith(query)) {
			return 1;
		}
	}

	if (lowerKey.includes(query)) {
		return 2;
	}

	for (const alias of aliases) {
		if (alias.toLowerCase().includes(query)) {
			return 3;
		}
	}

	if (entry.description.toLowerCase().includes(query)) {
		return 4;
	}

	return -1;
}

function formatReferenceAutocompleteItem(key: string, entry: ReferenceEntry): AutocompleteItem {
	const value = `@${key}`;
	const description = entry.description.trim()
		? `${entry.description} (${entry.path})`
		: entry.path;

	return {
		value,
		label: value,
		description,
	};
}

export function filterReferenceAutocompleteItems(
	references: Record<string, ReferenceEntry>,
	token: string,
): AutocompleteItem[] {
	const query = token.toLowerCase();

	return Object.entries(references)
		.map(([key, entry]) => ({
			key,
			entry,
			rank: getReferenceMatchRank(key, entry, query),
		}))
		.filter((row) => row.rank >= 0)
		.sort((left, right) => {
			if (left.rank !== right.rank) {
				return left.rank - right.rank;
			}
			return left.key.localeCompare(right.key);
		})
		.slice(0, MAX_REFERENCE_SUGGESTIONS)
		.map(({ key, entry }) => formatReferenceAutocompleteItem(key, entry));
}

export function createReferenceAutocompleteProvider(
	current: AutocompleteProvider,
	getReferences: () => Record<string, ReferenceEntry>,
): AutocompleteProvider {
	return {
		triggerCharacters: ["@"],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const line = lines[cursorLine] ?? "";
			const textBeforeCursor = line.slice(0, cursorCol);
			const token = extractReferenceToken(textBeforeCursor);

			if (token === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const prefix = `@${token}`;
			const referenceItems = filterReferenceAutocompleteItems(getReferences(), token);
			const currentResult = await current.getSuggestions(lines, cursorLine, cursorCol, options);

			if (options.signal.aborted) {
				return null;
			}

			if (referenceItems.length === 0) {
				return currentResult;
			}

			if (!currentResult || currentResult.prefix !== prefix) {
				return { prefix, items: referenceItems };
			}

			const seen = new Set(referenceItems.map((item) => item.value));
			const mergedItems = [...referenceItems];

			for (const item of currentResult.items) {
				if (seen.has(item.value)) {
					continue;
				}
				seen.add(item.value);
				mergedItems.push(item);
			}

			return { prefix, items: mergedItems };
		},
		applyCompletion(...args) {
			return current.applyCompletion(...args);
		},
		shouldTriggerFileCompletion(...args) {
			return current.shouldTriggerFileCompletion?.(...args) ?? true;
		},
	};
}