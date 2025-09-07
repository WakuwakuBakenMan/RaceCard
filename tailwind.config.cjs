/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}',
    './public/**/*.html',
  ],
  theme: {
    extend: {
      colors: {
        frame: {
          1: '#ffffff', // white
          2: '#000000', // black
          3: '#ff3b30', // red
          4: '#007aff', // blue
          5: '#ffcc00', // yellow
          6: '#34c759', // green
          7: '#ff9500', // orange
          8: '#ff2d55', // pink
        },
      },
    },
  },
  plugins: [],
};
