import { defineConfig } from 'vitest/config'

// Exclude .worktrees from test discovery — when collabs are in flight, agent
// worktrees contain stale copies of tests that vitest would otherwise pick up
// and run repeatedly, ballooning the suite from ~270 to 5000+ tests.
export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/.worktrees/**',
    ],
  },
})
