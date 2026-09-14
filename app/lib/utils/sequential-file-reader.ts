/**
 * Utilitaire de lecture / analyse séquentielle des fichiers d'un projet.
 *
 * Problème résolu : envoyer tous les fichiers d'un coup (150-200+) à l'IA
 * ou les charger simultanément saturaient la mémoire du navigateur et
 * provoquaient timeouts / corruption de données.
 *
 * Solution : traitement un par un (ou par très petits blocs) avec
 * affichage de la progression et petite pause anti-surcharge.
 */

export interface SequentialFileEntry {
  path: string;
  name?: string;
  content?: string;
  url?: string;
}

export interface SequentialProgress {
  current: number;
  total: number;
  fileName: string;
}

export type SequentialAnalyzer = (
  file: SequentialFileEntry,
  content: string,
  progress: SequentialProgress,
) => Promise<void> | void;

/**
 * Lit et analyse les fichiers un par un (séquentiel strict).
 *
 * @param fileList Liste des fichiers à traiter
 * @param fetchContent Fonction qui récupère le contenu d'un fichier
 * @param analyze Callback appelé pour chaque fichier (avec progression)
 * @param options pauseMs entre chaque fichier (défaut 200ms)
 */
export async function readFilesOneByOne(
  fileList: SequentialFileEntry[],
  fetchContent: (file: SequentialFileEntry) => Promise<string>,
  analyze: SequentialAnalyzer,
  options: { pauseMs?: number; onProgress?: (p: SequentialProgress) => void } = {},
): Promise<void> {
  const { pauseMs = 200, onProgress } = options;
  const total = fileList.length;

  console.log(`[sequential-reader] Total de fichiers à analyser : ${total}`);

  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    const current = i + 1;
    const fileName = file.name || file.path.split('/').pop() || file.path;

    const progress: SequentialProgress = { current, total, fileName };

    console.log(`[sequential-reader] Lecture (${current}/${total}) : ${fileName}`);
    onProgress?.(progress);

    try {
      const content = file.content ?? (await fetchContent(file));
      await analyze(file, content, progress);
    } catch (err) {
      console.warn(`[sequential-reader] Échec lecture ${file.path}`, err);

      // On continue les autres fichiers
    }

    if (i < fileList.length - 1 && pauseMs > 0) {
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }

  console.log(`[sequential-reader] Analyse terminée : ${total} fichiers traités.`);
}

/**
 * Variante par petits lots (ex: 3 fichiers) si on veut un peu plus de parallélisme
 * sans saturer la mémoire.
 */
export async function readFilesInSmallChunks(
  fileList: SequentialFileEntry[],
  fetchContent: (file: SequentialFileEntry) => Promise<string>,
  analyze: SequentialAnalyzer,
  options: { chunkSize?: number; pauseMs?: number; onProgress?: (p: SequentialProgress) => void } = {},
): Promise<void> {
  const { chunkSize = 3, pauseMs = 150, onProgress } = options;
  const total = fileList.length;

  console.log(`[sequential-reader] Total : ${total} fichiers, chunks de ${chunkSize}`);

  for (let i = 0; i < fileList.length; i += chunkSize) {
    const chunk = fileList.slice(i, i + chunkSize);

    await Promise.all(
      chunk.map(async (file, idx) => {
        const current = i + idx + 1;
        const fileName = file.name || file.path.split('/').pop() || file.path;
        const progress: SequentialProgress = { current, total, fileName };

        onProgress?.(progress);
        console.log(`[sequential-reader] Lecture (${current}/${total}) : ${fileName}`);

        try {
          const content = file.content ?? (await fetchContent(file));
          await analyze(file, content, progress);
        } catch (err) {
          console.warn(`[sequential-reader] Échec lecture ${file.path}`, err);
        }
      }),
    );

    if (i + chunkSize < fileList.length && pauseMs > 0) {
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }

  console.log(`[sequential-reader] Analyse par chunks terminée.`);
}
