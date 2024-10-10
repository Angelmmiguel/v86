"use strict";

/** @interface */
function FileStorageInterface() {}

/**
 * Read a portion of a file.
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @return {!Promise<Uint8Array>} null if file does not exist.
 */
FileStorageInterface.prototype.read = function(sha256sum, offset, count) {};

/**
 * Add a read-only file to the filestorage.
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 * @return {!Promise}
 */
FileStorageInterface.prototype.cache = function(sha256sum, data) {};

/**
 * Call this when the file won't be used soon, e.g. when a file closes or when this immutable
 * version is already out of date. It is used to help prevent accumulation of unused files in
 * memory in the long run for some FileStorage mediums.
 */
FileStorageInterface.prototype.uncache = function(sha256sum) {};

/**
 * @constructor
 * @implements {FileStorageInterface}
 */
function MemoryFileStorage()
{
    /**
     * From sha256sum to file data.
     * @type {Map<string,Uint8Array>}
     */
    this.filedata = new Map();
}

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @return {!Promise<Uint8Array>} null if file does not exist.
 */
MemoryFileStorage.prototype.read = async function(sha256sum, offset, count)
{
    dbg_assert(sha256sum, "MemoryFileStorage read: sha256sum should be a non-empty string");
    const data = this.filedata.get(sha256sum);

    if(!data)
    {
        return null;
    }

    return data.subarray(offset, offset + count);
};

/**
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 */
MemoryFileStorage.prototype.cache = async function(sha256sum, data)
{
    dbg_assert(sha256sum, "MemoryFileStorage cache: sha256sum should be a non-empty string");
    this.filedata.set(sha256sum, data);
};

/**
 * @param {string} sha256sum
 */
MemoryFileStorage.prototype.uncache = function(sha256sum)
{
    this.filedata.delete(sha256sum);
};


/**
 * @constructor
 * @param {FileSystemDirectoryHandle} dirHandler Directory handler from the browser API.
 * @param {number} [userId=1000] The user ID when mounting the files
 * @param {number} [groupId=1000] The group ID when mounting the files
 * @implements {FileStorageInterface}
 */
function LocalFileStorage(dirHandler, userId = 1000, groupId = 1000)
{
    // Store the handler so we can access files later
    this.handler = dirHandler;
    this.userId = userId;
    this.groupId = groupId;
}

/**
 * Iterate the files in a folder to build the filesystem JSON representation
 *
 * @param {FileSystemDirectoryHandle} handler Current folder handler
 * @param {object[]} fs The final filesystem. This method pushes entries into it
 * @param {number} size Current size in the folder
 * @param {string} basePath Base path for all the files in this folder
 * @return {object} The filesystem representation in current folder and the size
 */
LocalFileStorage.prototype._iterateDirectory() = async function(handler, fs, size, basePath) {
    for await (const entry of dir.values())
    {
        if (entry.kind === "file")
        {
            let file = await entry.getFile();
            fs.push(
                [
                    file.name,
                    file.size,
                    Math.round(file.lastModified / 1000),
                    33188, // File permissions
                    this.userId,
                    this.groupId,
                    `${basePath}/${file.name}`
                ]
            );
        } else
        {
            let newPath = `${basePath}/${entry.name}`;
            let iter = await this._iterateDirectory(entry, [], 0, newPath);
            fs.push(
                [
                    entry.name,
                    4096, // Filesize for folders
                    Math.round(Date.now() / 1000),
                    16877, // Folder permissions
                    this.userId,
                    this.groupId,
                    iter.fs,
                ]
            );

            size += iter.size + 4096;
        }
    }

    return { fs, size };
}

/**
 * Build the rootfs object based on the given handler. This file follows the format
 * from the fs2json script in the v86 repository.
 *
 * @param {FileSystemDirectoryHandle} handler The folder handler from the user action.
 * @return {object} The Rootfs objevt following the fs2json format
 */
LocalFileStorage.prototype.buildRootFs = async function(handler)
{
    let { fs, size } = await this._iterateDirectory(handler, [], 0, "");

    return {
        fsroot: fs,
        size,
        version: 3
    };
}

LocalFileStorage.prototype.read = async function(sha256sum, offset, count)
{
    let handler = this.handler;
    let content;  
    let folders = sha256sum.split("/");
    let filePath = folders.pop();

    for (let i = 0; i < folders.length; i++)
    {
        let folder = folders[i];

        if (folder != null && folder != "")
        {
            try
            {
                handler = await handler.getDirectoryHandle(folder, { mode: "read" });
            } catch (err) {
                return null;
            }
        }
    }

    try
    {
        let fileHandler = await handler.getFileHandle(filePath, { mode: "read" });
        let file = await fileHandler.getFile();

        // Retrieve the data
        let chunk = file.slice(offset, offset + count);
        let chunkBuf = await chunk.arrayBuffer();

        return new Uint8Array(chunkBuf);
    } catch (err) {
        console.error("Error retrieving the file content from the local directory folder: ", err);
        return null;
    }
}


LocalFileStorage.prototype.cache = function(sha256sum, data)
{
    // TODO: Implement caching
    return Promise.resolve();
}


LocalFileStorage.prototype.uncache = function(sha256sum)
{
  // TODO: Implement uncaching
}

/**
 * @constructor
 * @implements {FileStorageInterface}
 * @param {FileStorageInterface} file_storage
 * @param {string} baseurl
 */
function ServerFileStorageWrapper(file_storage, baseurl)
{
    dbg_assert(baseurl, "ServerMemoryFileStorage: baseurl should not be empty");

    if(!baseurl.endsWith("/"))
    {
        baseurl += "/";
    }

    this.storage = file_storage;
    this.baseurl = baseurl;
}

/**
 * @param {string} sha256sum
 * @return {!Promise<Uint8Array>}
 */
ServerFileStorageWrapper.prototype.load_from_server = function(sha256sum)
{
    return new Promise((resolve, reject) =>
    {
        v86util.load_file(this.baseurl + sha256sum, { done: async buffer =>
        {
            const data = new Uint8Array(buffer);
            await this.cache(sha256sum, data);
            resolve(data);
        }});
    });
};

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @return {!Promise<Uint8Array>}
 */
ServerFileStorageWrapper.prototype.read = async function(sha256sum, offset, count)
{
    const data = await this.storage.read(sha256sum, offset, count);
    if(!data)
    {
        const full_file = await this.load_from_server(sha256sum);
        return full_file.subarray(offset, offset + count);
    }
    return data;
};

/**
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 */
ServerFileStorageWrapper.prototype.cache = async function(sha256sum, data)
{
    return await this.storage.cache(sha256sum, data);
};

/**
 * @param {string} sha256sum
 */
ServerFileStorageWrapper.prototype.uncache = function(sha256sum)
{
    this.storage.uncache(sha256sum);
};
