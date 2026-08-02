/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./overlay.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        pixel: ['"Press Start 2P"', "ui-monospace", "monospace"],
      },
      colors: {
        bichito: {
          bg: "#1a1625",
          panel: "#221c30",
          accent: "#a78bfa",
          accent2: "#f472b6",
        },
      },
    },
  },
  plugins: [],
};
