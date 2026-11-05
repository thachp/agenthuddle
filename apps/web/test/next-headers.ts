export const headers = async () => new Headers();
export const cookies = async () => ({ get: () => undefined, getAll: () => [] });
