// #199: CI can use a public mirror while local development keeps the existing image.
export const TEST_POSTGRES_IMAGE = process.env.ARDUR_TEST_POSTGRES_IMAGE ?? "postgres:16-alpine";
