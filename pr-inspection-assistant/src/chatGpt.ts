import tl from './taskWrapper';
import { encode } from 'gpt-tokenizer';
import { OpenAI, AzureOpenAI } from 'openai';
import parseGitDiff, { AddedLine, AnyChunk, AnyLineChange, DeletedLine, GitDiff, UnchangedLine } from 'parse-git-diff';
import { CommentLineNumberAndOffsetFixer } from './commentLineNumberAndOffsetFixer';
import { Review } from './types/review';
import { Logger } from './logger';

type Client = OpenAI | AzureOpenAI;

export class ChatGPT {
    private readonly systemMessage: string = '';
    private readonly maxTokens: number = 128000;
    private _client: Client;
    private _enableCommentLineCorrection: boolean = false;

    constructor(
        client: Client,
        checkForBugs: boolean = true,
        checkForPerformance: boolean = true,
        checkForBestPractices: boolean = true,
        modifiedLinesOnly: boolean = true,
        enableCommentLineCorrection = false,
        additionalPrompts: string[] = [],
        enableConfidenceMode: boolean = false
    ) {
        this._client = client; // Assign to private field
        this._enableCommentLineCorrection = enableCommentLineCorrection;


        let details: string[] = [];
        if (checkForBugs) details.push("Highlight any bugs.");
        if (checkForPerformance) details.push("Highlight major performance problems.");
        if (checkForBestPractices) {
            details.push("Provide details on missed use of best practices.");
        } else {
            details.push("Do not provide comments on best practices.");
        }
        if (modifiedLinesOnly) details.push("Only comment on new or modified lines.");
        if (additionalPrompts.length > 0) details.push(...additionalPrompts);

        this.systemMessage =
            "You are an expert software engineer performing a code review. Provide actionable, high-quality feedback on the code changes." +
            (details.length > 0 ? " " + details.join(" ") : "");

        console.info(`System prompt:\n${this.systemMessage}`);
    }

    public async performCodeReview({diff, fileName, existingComments, rulesContext,prContext, pullRequestDescription}:
    { diff: string,
        fileName: string,
        existingComments: string[],
        rulesContext: string,
        prContext: string,
        pullRequestDescription: string
    }
    ): Promise<Review> {
        const review = await this.sendRequest(diff, fileName, existingComments, rulesContext, prContext, pullRequestDescription);

        // Log threads missing threadContext or filePath for debugging
        if (review && Array.isArray(review.threads)) {

            Logger.info(`Processing review threads for file: ${fileName}`);
            for (const thread of review.threads) {
                Logger.info(`Thread: ${JSON.stringify(thread, null, 2)}`);    
                if (!thread.threadContext || !thread.threadContext.filePath) {
                    Logger.error('Thread missing threadContext or filePath:', JSON.stringify(thread, null, 2));
                }
            }
        }

        this._enableCommentLineCorrection && CommentLineNumberAndOffsetFixer.fix(review, diff);
        return review;
    }

    private async sendRequest(
        diff: string,
        fileName: string,
        existingComments: string[],
        rulesContext: string = "",
        prContext: string = "",
        pullRequestDescription: string = ""
    ): Promise<Review> {
        const emptyReview: Review = { threads: [] };

        if (!fileName.startsWith('/')) {
            fileName = `/${fileName}`;
        }
        let model = tl.getInput('ai_model', true) as
            | (string & {})
            | 'gpt-3.5-turbo'
            | 'gpt-4'
            | 'gpt-4.1'
            | 'gpt-4.1-mini'
            | 'gpt-4o'
            | 'gpt-5.1'
            | 'gpt-5.1-codex'
            | 'gpt-5.1-mini'
            | 'o1'
            | 'o1-mini'
            | 'o1-preview'
            | 'o3-mini'
            | 'o4-mini';

        let userPrompt = {
            fileName: fileName,
            diff: diff,
            existingComments: existingComments,
            pullRequestDescription: pullRequestDescription,
            prContext: prContext
        };


        // Prepend rules context to the prompt if present
        let prompt = rulesContext ? (rulesContext + "\n\n" + JSON.stringify(userPrompt, null, 4)) : JSON.stringify(userPrompt, null, 4);

        Logger.info(`Diff:\n${diff}`);
        Logger.debug(`Using OpenAI model: ${model}`);

        // Improved schema: Explicitly define structure for comments and threadContext
        const tools = [
            {
                type: "function" as const,
                function: {
                    name: "returnReview",
                    description: "Return a code review in structured format.",
                    parameters: {
                        type: "object",
                        properties: {
                            threads: {
                                type: "array",
                                description: "Review threads.",
                                items: {
                                    type: "object",
                                    properties: {
                                        comments: {
                                            type: "array",
                                            description: "List of comments in this thread.",
                                            items: {
                                                type: "object",
                                                properties: {
                                                    content: { type: "string", description: "The text of the comment." },
                                                    commentType: { type: "number", description: "2 for regular comment." }
                                                },
                                                required: ["content", "commentType"]
                                            }
                                        },
                                        status: { type: "number", description: "Thread status, 1 for active." },
                                        threadContext: {
                                            type: "object",
                                            description: "Context for the thread.",
                                            properties: {
                                                filePath: { type: "string", description: "Path to the file for this thread." }
                                            },
                                            required: ["filePath"]
                                        },
                                        confidenceScore: {
                                            type: "number",
                                            description: "Confidence in the validity of the comment, from 1 (low) to 10 (high).",
                                            minimum: 1,
                                            maximum: 10
                                        }
                                    },
                                    required: ["comments", "status", "threadContext", "confidenceScore"]
                                }
                            }
                        },
                        required: ["threads"]
                    }
                }
            }
        ];

        if (!this.doesMessageExceedTokenLimit(this.systemMessage + prompt, this.maxTokens)) {
            Logger.debug(`System Message: \n${this.systemMessage}\n\nPrompt:\n${prompt}`);
         const chatResponse = await this._client.chat.completions.create({
                model: model,
                messages: [
                    { role: "system", content: this.systemMessage },
                    { role: "user", content: prompt }
                ],
                tools: tools,
                tool_choice: { type: "function", function: { name: "returnReview" } }
            });

            const choice = chatResponse.choices[0];
            if (choice.finish_reason === "tool_calls" && choice.message.tool_calls) {
                for (const toolCall of choice.message.tool_calls) {
                    if (toolCall.type === "function" && toolCall.function && toolCall.function.name === "returnReview") {
                        try {
                            const args = JSON.parse(toolCall.function.arguments);
                            Logger.info(`Comments (function call):\n${JSON.stringify(args)}`);
                            return args as Review;
                        } catch (error) {
                            Logger.error(
                                `Failed to parse function call response for file ${fileName}. Returning empty review`,
                                error
                            );
                            return emptyReview;
                        }
                    }
                }
            }
            Logger.error(`No valid function call found in response for file ${fileName}. Returning empty review`);
            return emptyReview;
        }
        tl.warning(`Unable to process diff for file ${fileName} as it exceeds token limits.`);
        return emptyReview;
    }

    private doesMessageExceedTokenLimit(message: string, tokenLimit: number): boolean {
        let tokens = encode(message);
        console.info(`Token count: ${tokens.length}`);
        return tokens.length > tokenLimit;
    }
}
