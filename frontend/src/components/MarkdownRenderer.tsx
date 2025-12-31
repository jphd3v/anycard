import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

/**
 * Shared markdown renderer component that ensures consistent styling
 * across lobby and in-game rule displays.
 */
export function MarkdownRenderer({
  content,
  className = "",
}: MarkdownRendererProps) {
  return (
    <div
      className={`prose prose-sm prose-invert max-w-none text-ink markdown-content font-sans text-sm leading-relaxed first:mt-0 ${className}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Ensure the first header doesn't have massive top margin since our sticky headers handle titles
          h2: ({ className: h2ClassName, ...props }) => (
            <h2 className={`${h2ClassName} mt-6 first:mt-0`} {...props} />
          ),
          // Link override with proper styling and security attributes
          a: ({ href, children, ...props }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary-hover underline decoration-primary/30 underline-offset-2 transition-colors font-medium"
              {...props}
            >
              {children}
            </a>
          ),
          // Custom component to safely handle suit symbols
          span: ({ className: spanClassName, children, ...props }) => {
            // Only apply red color to hearts and diamonds
            if (
              typeof children === "string" &&
              (children.includes("♥") || children.includes("♦"))
            ) {
              return (
                <span
                  className={spanClassName}
                  style={{ color: "#dc2626" }}
                  {...props}
                >
                  {children}
                </span>
              );
            }
            return (
              <span className={spanClassName} {...props}>
                {children}
              </span>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
