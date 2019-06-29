import path from 'path';
import { getRootQuery } from 'gatsby-source-graphql-universal/getRootQuery';
import { onCreateWebpackConfig, sourceNodes } from 'gatsby-source-graphql-universal/gatsby-node';
import { fieldName, PrismicLink, typeName } from './utils';
import { PluginOptions } from './interfaces/PluginOptions';
import { createRemoteFileNode } from 'gatsby-source-filesystem';
import pathToRegexp from 'path-to-regexp';

exports.onCreateWebpackConfig = onCreateWebpackConfig;

exports.onCreatePage = ({ page, actions }: any) => {
  const rootQuery = getRootQuery(page.componentPath);
  page.context = page.context || {};
  if (rootQuery) {
    page.context.rootQuery = rootQuery;
    actions.createPage(page);
  }
};

exports.sourceNodes = (ref: any, options: PluginOptions) => {
  const opts = {
    fieldName,
    typeName,
    createLink: () =>
      PrismicLink({
        uri: `https://${options.repositoryName}.prismic.io/graphql`,
        credentials: 'same-origin',
        accessToken: options.accessToken as any,
        customRef: options.prismicRef as any,
      }),
    ...options,
  };

  return sourceNodes(ref, opts);
};

function createGeneralPreviewPage(createPage: Function, options: PluginOptions) {
  const previewPath = options.previewPath || '/preview';
  createPage({
    path: previewPath.replace(/^\//, ''),
    component: path.resolve(path.join(__dirname, 'components', 'PreviewPage.js')),
    context: {
      prismicPreviewPage: true,
    },
  });
}

function createDocumentPreviewPage(createPage: Function, options: PluginOptions, page: any) {
  createPage({
    path: page.path,
    matchPath: process.env.NODE_ENV === 'production' ? undefined : page.match,
    component: page.component,
    context: {
      rootQuery: getRootQuery(page.component),
      id: '',
      uid: '',
      lang: options.defaultLang,
    },
  });
}

function createDocumentPages(
  createPage: Function,
  edges: [any?],
  options: PluginOptions,
  page: any
) {
  // Cycle through each document returned from query...
  edges.forEach(({ cursor, node }: any, index: number) => {
    const lang = node._meta.lang === options.defaultLang ? null : node._meta.lang;
    const params = { ...node._meta, lang };
    const toPath = pathToRegexp.compile(page.match || page.path);
    const path = toPath(params);

    // ...and create the page
    createPage({
      path: path === '' ? '/' : path,
      component: page.component,
      context: {
        rootQuery: getRootQuery(page.component),
        ...node._meta,
        cursor,
        prevPageMeta: edges[index - 1] ? edges[index - 1].node._meta : null,
        nextPageMeta: edges[index + 1] ? edges[index + 1].node._meta : null,
        lastPageEndCursor: edges[index - 1] ? edges[index - 1].endCursor : '',
      },
    });
  });
}

const getDocumentsQuery = ({ documentType }: { documentType: string }) => `
  query AllPagesQuery ($after: String, $lang: String!, $sortBy: PRISMIC_SortPosty) {
    prismic {
      ${documentType} (
        first: 20
        after: $after
        sortBy: $sortBy
        lang: $lang
      ) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          cursor
          node {
            _meta {
              id
              lang
              uid
              type
              alternateLanguages {
                id
                lang
                type
                uid
              }
            }
          }
        }
      }
    }
  }
`;

exports.createPages = async ({ graphql, actions: { createPage } }: any, options: PluginOptions) => {
  createGeneralPreviewPage(createPage, options);
  let documents: [any?] = [];

  /**
   * Helper that recursively queries GraphQL to collect all documents for the given
   * page type. Once all documents are collected, it creates pages for them all.
   * Prismic GraphQL queries only return up to 20 results per query)
   */
  async function createPagesForType(page: any, endCursor: string = '') {
    const documentType = `all${page.type}s`;
    const query = getDocumentsQuery({ documentType });

    // TODO: Fix language support
    const lang = page.lang || options.defaultLang;
    const { data, errors } = await graphql(query, { after: endCursor, lang, sortBy: page.sortBy });

    if (errors && errors.length) {
      throw errors[0];
    }

    const response = data.prismic[documentType];

    // Add last end cursor to all edges to enable pagination context when creating pages
    response.edges.forEach((edge: any) => (edge.endCursor = endCursor));

    // Stage documents for page creation
    documents = [...documents, ...response.edges] as [any?];

    if (response.pageInfo.hasNextPage) {
      const newEndCursor = response.pageInfo.endCursor;
      await createPagesForType(page, newEndCursor);
    } else {
      createDocumentPreviewPage(createPage, options, page);
      createDocumentPages(createPage, documents, options, page);
      documents = []; // empty out the array for the next document type
    }
  }

  // Create all the pages!
  const pages = options.pages || [];
  const pageCreators = pages.map(page => createPagesForType(page));
  await Promise.all(pageCreators);
};

exports.createResolvers = (
  { actions, cache, createNodeId, createResolvers, store, reporter }: any,
  { sharpKeys = [/image|photo|picture/] }: PluginOptions
) => {
  const { createNode } = actions;

  const state = store.getState();
  const [prismicSchema = {}] = state.schemaCustomization.thirdPartySchemas;
  const typeMap = prismicSchema._typeMap;
  const resolvers: { [key: string]: any } = {};

  for (const typeName in typeMap) {
    const typeEntry = typeMap[typeName];
    const typeFields = (typeEntry && typeEntry.getFields && typeEntry.getFields()) || {};
    const typeResolver: { [key: string]: any } = {};
    for (const fieldName in typeFields) {
      const field = typeFields[fieldName];
      if (
        field.type === typeMap.PRISMIC_Json &&
        sharpKeys.some((re: RegExp | string) =>
          re instanceof RegExp ? re.test(fieldName) : re === fieldName
        )
      ) {
        typeResolver[`${fieldName}Sharp`] = {
          type: 'File',
          args: {
            crop: { type: typeMap.String },
          },
          resolve(source: any, args: any) {
            const obj = (source && source[fieldName]) || {};
            const url = args.crop ? obj[args.crop] && obj[args.crop].url : obj.url;
            if (url) {
              return createRemoteFileNode({
                url,
                store,
                cache,
                createNode,
                createNodeId,
                reporter,
              });
            }
            return null;
          },
        };
      }
    }
    if (Object.keys(typeResolver).length) {
      resolvers[typeName] = typeResolver;
    }
  }

  if (Object.keys(resolvers).length) {
    createResolvers(resolvers);
  }
};
