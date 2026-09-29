/** Queue names (GODFATHER §5.6). Jobs carry only IDs; Postgres is the source of truth. */
export const QUEUES = {
  EMAIL: 'email-send',
  NOTIFY: 'notifications',
  INDEX: 'search-index',
} as const;
