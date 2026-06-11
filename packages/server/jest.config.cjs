/** @type {import('jest').Config} */
module.exports = {
  maxWorkers: '50%',
  workerIdleMemoryLimit: '50MB',
  resetModules: true,
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  transformIgnorePatterns: ['node_modules/(?!(kysely|nestjs-kysely)/)'],
  moduleNameMapper: {
    '^@mastra/core$': '<rootDir>/../test/mastra-stub.ts',
    '^@mastra/core/agent$': '<rootDir>/../test/mastra-stub.ts',
    '^@mastra/core/workflows$': '<rootDir>/../test/mastra-stub.ts',
    '^@mastra/libsql$': '<rootDir>/../test/mastra-stub.ts',
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
};
