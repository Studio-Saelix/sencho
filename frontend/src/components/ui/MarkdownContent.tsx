import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

/**
 * Renders a markdown string (e.g. GitHub release notes) as styled React
 * elements. Raw HTML in the source is intentionally not rendered, so the
 * output is safe from injected markup.
 */
const components: Components = {
    h1: ({ children }) => (
        <h1 className="text-base font-semibold text-stat-value mt-5 first:mt-0 mb-2">{children}</h1>
    ),
    h2: ({ children }) => (
        <h2 className="text-sm font-semibold text-stat-value mt-5 first:mt-0 mb-2">{children}</h2>
    ),
    h3: ({ children }) => (
        <h3 className="text-xs font-semibold uppercase tracking-wide text-stat-subtitle mt-4 first:mt-0 mb-1.5">{children}</h3>
    ),
    p: ({ children }) => (
        <p className="text-sm text-stat-value leading-relaxed my-2 first:mt-0 last:mb-0">{children}</p>
    ),
    ul: ({ children }) => (
        <ul className="list-disc pl-5 space-y-1 my-2 text-sm text-stat-value">{children}</ul>
    ),
    ol: ({ children }) => (
        <ol className="list-decimal pl-5 space-y-1 my-2 text-sm text-stat-value">{children}</ol>
    ),
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    a: ({ href, children }) => (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand hover:underline"
        >
            {children}
        </a>
    ),
    code: ({ children }) => (
        <code className="font-mono text-[0.8125rem] rounded bg-card-border/40 px-1 py-0.5 text-stat-value">{children}</code>
    ),
    pre: ({ children }) => (
        // The fenced block owns its frame; neutralize the inline-code pill on the
        // inner <code> so it does not paint a background inside the block.
        <pre className="font-mono text-xs rounded-md border border-card-border bg-card-border/20 p-3 overflow-x-auto my-2 [&>code]:bg-transparent [&>code]:p-0 [&>code]:rounded-none">{children}</pre>
    ),
    strong: ({ children }) => <strong className="font-semibold text-stat-value">{children}</strong>,
    blockquote: ({ children }) => (
        <blockquote className="border-l-2 border-card-border pl-3 text-stat-subtitle italic my-2">{children}</blockquote>
    ),
    hr: () => <hr className="border-card-border/60 my-4" />,
};

export function MarkdownContent({ children, className }: { children: string; className?: string }) {
    return (
        <div className={cn('break-words', className)}>
            <Markdown remarkPlugins={[remarkGfm]} components={components}>
                {children}
            </Markdown>
        </div>
    );
}
