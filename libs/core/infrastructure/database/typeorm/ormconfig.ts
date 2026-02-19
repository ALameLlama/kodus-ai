import 'dotenv/config';
import { join } from 'path';

import { DataSource, DataSourceOptions } from 'typeorm';
import { SeederOptions } from 'typeorm-extension';

import MainSeeder from './seed/main.seeder';
import { ENTITIES } from './entities';

const env = process.env.API_DATABASE_ENV ?? process.env.API_NODE_ENV;
const isProduction = !['development', 'test'].includes(env);
const disableSSL = process.env.API_DATABASE_DISABLE_SSL === 'true';
const useSSL = isProduction && !disableSSL;

const optionsDataBase: DataSourceOptions = {
    type: 'postgres',
    host: process.env.API_PG_DB_HOST,
    port: parseInt(process.env.API_PG_DB_PORT!, 10),
    username: process.env.API_PG_DB_USERNAME,
    password: process.env.API_PG_DB_PASSWORD,
    database: process.env.API_PG_DB_DATABASE,
    logging: false,
    logger: 'file',
    synchronize: false,
    cache: false,
    migrationsRun: false,
    // Allow individual migrations to override transaction mode
    // Required for CREATE INDEX CONCURRENTLY (must run outside transactions)
    migrationsTransactionMode: 'each',
    entities: ENTITIES,
    migrations: [join(__dirname, './migrations/*{.ts,.js}')],
    ssl: useSSL,
    extra: {
        max: 10,
        min: 1,
        idleTimeoutMillis: 60000,
        connectionTimeoutMillis: 60000,
        keepAlive: true,
        ...(useSSL
            ? {
                  ssl: {
                      rejectUnauthorized: false,
                  },
              }
            : {}),
    },
};

const mergedConfig = optionsDataBase;

const optionsSeeder: SeederOptions = {
    factories: [],
    seeds: [MainSeeder],
};

const AppDataSource = new DataSource({ ...mergedConfig, ...optionsSeeder });

export const dataSourceInstance = AppDataSource;
