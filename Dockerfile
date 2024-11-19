FROM node:18 as build
WORKDIR /app
COPY ./package.json .
COPY ./yarn.lock .
RUN yarn install
COPY . .

FROM node:18 AS deps
WORKDIR /app
COPY --from=build /app/package.json .
COPY --from=build /app/yarn.lock .
RUN yarn install --production

FROM node:18
WORKDIR /app
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=deps /app/package.json .
COPY --from=deps /app/yarn.lock .
COPY --from=deps /app/node_modules ./node_modules
EXPOSE 3000
CMD ["yarn","start"]