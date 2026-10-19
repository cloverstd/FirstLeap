import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AIImage } from "./ai";

export default function AIMarkdown({
  content,
  images,
}: {
  content: string;
  images: AIImage[];
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        img: ({ src, alt }) => {
          const image = images.find(
            (im) =>
              typeof src === "string" &&
              src.startsWith(`/api/ai/images/${im.id}`),
          );
          return image?.version ? (
            <img src={image.url} alt={alt || image.caption} loading="lazy" />
          ) : null;
        },
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
