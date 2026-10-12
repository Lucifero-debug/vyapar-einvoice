// eslint-config-next 16 ships flat config itself, so the FlatCompat bridge
// that version 15 needed (and that cannot read the new format) is gone.
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  // `next lint` used to decide what was linted. ESLint run directly (which
  // Next.js 16 requires -- the `next lint` command is gone) lints everything
  // below this folder except node_modules, so the build output, the desktop
  // and phone shells' bundles and the old Python service are excluded here.
  {
    ignores: [
      ".next/**",
      "out/**",
      "dist/**",
      "build/**",
      "android/**",
      "ios/**",
      "backend/**",
      "public/**",
      "next-env.d.ts",
    ],
  },
  ...nextVitals,
  {
    rules: {
      // New in eslint-plugin-react-hooks 7 (with eslint-config-next 16), and
      // an error there. It flags the load-on-mount pattern used across the
      // app -- `useEffect(() => { load(); }, [load])`, where load() sets a
      // "loading" flag first -- and form resets on open. That pattern renders
      // twice, it does not break anything, and rewriting ~30 screens to
      // silence it is a refactor with no UI tests behind it. Kept visible as a
      // WARNING, not switched off, so each one stays listed until it is moved
      // to a data hook or a key-based reset. PROJECT_CONTEXT.md §6.36.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];

export default eslintConfig;
