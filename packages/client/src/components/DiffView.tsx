import { useMemo } from 'react';
import { html, Diff2HtmlConfig } from 'diff2html';
import 'diff2html/bundles/css/diff2html.min.css';

interface Props {
  diff: string;
}

const config: Diff2HtmlConfig = {
  outputFormat: 'line-by-line',
  drawFileList: false,
  matching: 'lines',
  diffStyle: 'word',
};

export function DiffView({ diff }: Props) {
  const rendered = useMemo(() => html(diff, config), [diff]);

  return (
    <div
      className="r2-diff-view"
      dangerouslySetInnerHTML={{ __html: rendered }}
    />
  );
}
