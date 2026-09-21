/**
 * EJR Software — Design System 2.0
 * Destino no app Lovable: tailwind.config.ts
 *
 * Mantem o contrato de nomes do shadcn/ui e adiciona os tokens EJR
 * (escala do verde, neutros quentes, feedback, raios, sombras e alturas
 * de controle) definidos em src/index.css.
 */
import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./pages/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./app/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
  ],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "24px",
      screens: {
        "2xl": "1200px",
      },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
          hover: "hsl(var(--ejr-primary-hover))",
          active: "hsl(var(--ejr-primary-active))",
          50: "hsl(var(--ejr-primary-50))",
          100: "hsl(var(--ejr-primary-100))",
          200: "hsl(var(--ejr-primary-200))",
          300: "hsl(var(--ejr-primary-300))",
          400: "hsl(var(--ejr-primary-400))",
          500: "hsl(var(--ejr-primary-500))",
          600: "hsl(var(--ejr-primary-600))",
          700: "hsl(var(--ejr-primary-700))",
          800: "hsl(var(--ejr-primary-800))",
          900: "hsl(var(--ejr-primary-900))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
          subtle: "hsl(var(--ejr-danger-bg))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
          hover: "hsl(var(--ejr-surface-hover))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
        success: {
          DEFAULT: "hsl(var(--ejr-success))",
          subtle: "hsl(var(--ejr-success-bg))",
        },
        warning: {
          DEFAULT: "hsl(var(--ejr-warning))",
          subtle: "hsl(var(--ejr-warning-bg))",
        },
        info: {
          DEFAULT: "hsl(var(--ejr-info))",
          subtle: "hsl(var(--ejr-info-bg))",
        },
        strong: "hsl(var(--ejr-border-strong))",
        tertiary: "hsl(var(--ejr-text-tertiary))",
      },
      fontFamily: {
        sans: ["Inter Variable", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        body: ["Inter Variable", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        heading: ["Montserrat", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: {
        sm: "4px",
        md: "6px",
        lg: "8px",
        card: "12px",
        panel: "16px",
        pill: "999px",
      },
      boxShadow: {
        xs: "var(--shadow-xs)",
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
      spacing: {
        "control-sm": "32px",
        control: "36px",
        "control-lg": "40px",
      },
      maxWidth: {
        container: "1200px",
        content: "760px",
      },
      letterSpacing: {
        eyebrow: "0.14em",
        heading: "-0.025em",
        display: "-0.045em",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
      transitionDuration: {
        DEFAULT: "160ms",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
