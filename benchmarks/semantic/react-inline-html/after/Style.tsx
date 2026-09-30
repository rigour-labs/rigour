import { useMemo } from 'react';
export function InlineStyle(props: { css: string }) {
  const html = useMemo(() => ({ __html: props.css }), [props.css]);
  return <style dangerouslySetInnerHTML={html} />;
}
