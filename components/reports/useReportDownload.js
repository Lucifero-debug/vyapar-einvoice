'use client';

import { useCallback, useState } from 'react';
import { useNotice } from '@/components/ui/notice';
import { downloadFrom } from '@/lib/downloadFile.mjs';

/**
 * A report screen's Download buttons: busy while the file is being made, and
 * a message on the screen -- not a page of raw JSON in its place -- when it
 * cannot be. See lib/downloadFile.mjs.
 *
 *   const exporter = useReportDownload();
 *   <button onClick={() => exporter.download(url)} disabled={exporter.busy}>
 *   <Notice notice={exporter.notice} onClose={exporter.notify.clear} />
 */
export function useReportDownload() {
  const [notice, notify] = useNotice();
  const [busy, setBusy] = useState(false);

  const download = useCallback(
    async (url, options) => {
      if (busy) return;
      setBusy(true);
      notify.info('Preparing the download…');
      const result = await downloadFrom(url, options);
      if (result.ok) notify.clear();
      else notify.error(`The download did not start. ${result.message}`);
      setBusy(false);
    },
    [busy, notify]
  );

  return { notice, notify, busy, download };
}

export default useReportDownload;
