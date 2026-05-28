export interface Database {
  users: UserTable;
}

export interface UserTable {
  id?: number;
  email: string;
  name: string;
  created_at?: number;
}
