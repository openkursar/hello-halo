/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/renderer/**/*.{js,ts,jsx,tsx,html}',
  ],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // Halo brand colors
        'halo-glow': 'hsl(var(--halo-glow))',
        'halo-success': 'hsl(var(--halo-success))',
        'halo-warning': 'hsl(var(--halo-warning))',
        'halo-error': 'hsl(var(--halo-error))',

        // App type accent colors
        'app-skill': 'hsl(var(--app-skill))',
        'app-mcp': 'hsl(var(--app-mcp))',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      // GitHub-like typography customization
      typography: ({ theme }) => ({
        DEFAULT: {
          css: {
            '--tw-prose-body': 'hsl(var(--foreground))',
            '--tw-prose-headings': 'hsl(var(--foreground))',
            '--tw-prose-lead': 'hsl(var(--muted-foreground))',
            '--tw-prose-links': 'hsl(var(--primary))',
            '--tw-prose-bold': 'hsl(var(--foreground))',
            '--tw-prose-counters': 'hsl(var(--muted-foreground))',
            '--tw-prose-bullets': 'hsl(var(--muted-foreground))',
            '--tw-prose-hr': 'hsl(var(--border))',
            '--tw-prose-quotes': 'hsl(var(--foreground))',
            '--tw-prose-quote-borders': 'hsl(var(--border))',
            '--tw-prose-captions': 'hsl(var(--muted-foreground))',
            '--tw-prose-code': 'hsl(var(--foreground))',
            '--tw-prose-pre-code': 'hsl(var(--foreground))',
            '--tw-prose-pre-bg': 'hsl(var(--secondary))',
            '--tw-prose-th-borders': 'hsl(var(--border))',
            '--tw-prose-td-borders': 'hsl(var(--border))',
            // Invert colors (for dark mode)
            '--tw-prose-invert-body': 'hsl(var(--foreground))',
            '--tw-prose-invert-headings': 'hsl(var(--foreground))',
            '--tw-prose-invert-lead': 'hsl(var(--muted-foreground))',
            '--tw-prose-invert-links': 'hsl(var(--primary))',
            '--tw-prose-invert-bold': 'hsl(var(--foreground))',
            '--tw-prose-invert-counters': 'hsl(var(--muted-foreground))',
            '--tw-prose-invert-bullets': 'hsl(var(--muted-foreground))',
            '--tw-prose-invert-hr': 'hsl(var(--border))',
            '--tw-prose-invert-quotes': 'hsl(var(--foreground))',
            '--tw-prose-invert-quote-borders': 'hsl(var(--border))',
            '--tw-prose-invert-captions': 'hsl(var(--muted-foreground))',
            '--tw-prose-invert-code': 'hsl(var(--foreground))',
            '--tw-prose-invert-pre-code': 'hsl(var(--foreground))',
            '--tw-prose-invert-pre-bg': 'hsl(var(--secondary))',
            '--tw-prose-invert-th-borders': 'hsl(var(--border))',
            '--tw-prose-invert-td-borders': 'hsl(var(--border))',
            // GitHub-like spacing and sizing
            maxWidth: 'none',
            lineHeight: '1.7',
            // Headings - GitHub style with border-bottom for h1/h2
            h1: {
              fontSize: '2em',
              fontWeight: '600',
              marginTop: '1.5em',
              marginBottom: '1em',
              paddingBottom: '0.3em',
              borderBottom: '1px solid hsl(var(--border))',
            },
            h2: {
              fontSize: '1.5em',
              fontWeight: '600',
              marginTop: '1.5em',
              marginBottom: '0.75em',
              paddingBottom: '0.3em',
              borderBottom: '1px solid hsl(var(--border))',
            },
            h3: {
              fontSize: '1.25em',
              fontWeight: '600',
              marginTop: '1.5em',
              marginBottom: '0.5em',
            },
            h4: {
              fontSize: '1em',
              fontWeight: '600',
              marginTop: '1.5em',
              marginBottom: '0.5em',
            },
            // Paragraphs
            p: {
              marginTop: '0',
              marginBottom: '1em',
            },
            // Links - base styles (component adds target="_blank")
            a: {
              color: 'hsl(var(--primary))',
              textDecoration: 'none',
              '&:hover': {
                textDecoration: 'underline',
              },
            },
            // Inline code only (code blocks handled by component with not-prose)
            ':not(pre) > code': {
              backgroundColor: 'hsl(var(--muted))',
              padding: '0.2em 0.4em',
              borderRadius: '6px',
              fontSize: '85%',
              fontWeight: '400',
              '&::before': { content: 'none' },
              '&::after': { content: 'none' },
            },
            // Code blocks - base styles (component wraps with not-prose for CopyButton)
            pre: {
              backgroundColor: 'hsl(var(--muted) / 0.5)',
              borderRadius: '6px',
              padding: '1em',
              overflow: 'auto',
              fontSize: '85%',
              lineHeight: '1.45',
            },
            'pre code': {
              backgroundColor: 'transparent',
              padding: '0',
              borderRadius: '0',
              fontSize: 'inherit',
            },
            // Blockquotes - GitHub style with left border
            blockquote: {
              borderLeftWidth: '4px',
              borderLeftColor: 'hsl(var(--border))',
              color: 'hsl(var(--muted-foreground))',
              paddingLeft: '1em',
              marginLeft: '0',
              fontStyle: 'normal',
            },
            // Lists
            ul: {
              paddingLeft: '2em',
              marginTop: '0',
              marginBottom: '1em',
            },
            ol: {
              paddingLeft: '2em',
              marginTop: '0',
              marginBottom: '1em',
            },
            li: {
              marginTop: '0.25em',
              marginBottom: '0.25em',
            },
            'li > ul, li > ol': {
              marginTop: '0.25em',
              marginBottom: '0.25em',
            },
            // Tables - GitHub style
            table: {
              width: '100%',
              borderCollapse: 'collapse',
              marginTop: '0',
              marginBottom: '1em',
            },
            thead: {
              borderBottom: '2px solid hsl(var(--border))',
            },
            'thead th': {
              padding: '0.75em 1em',
              fontWeight: '600',
              textAlign: 'left',
            },
            'tbody td': {
              padding: '0.75em 1em',
              borderTop: '1px solid hsl(var(--border))',
            },
            'tbody tr:nth-child(even)': {
              backgroundColor: 'hsl(var(--muted) / 0.3)',
            },
            // Horizontal rule
            hr: {
              borderColor: 'hsl(var(--border))',
              marginTop: '1.5em',
              marginBottom: '1.5em',
            },
            // Images - component handles path resolution and 880px max-width
          },
        },
      }),
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
