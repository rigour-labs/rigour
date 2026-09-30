export function InlineStyle(props: { css: string }) {
  return <style dangerouslySetInnerHTML={{ __html: props.css }} />;
}
